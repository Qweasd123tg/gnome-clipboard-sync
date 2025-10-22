'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async', 'connect_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async', 'write_all_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

const SELECTION_KEYS = new Map([
    [St.ClipboardType.CLIPBOARD, 'CLIPBOARD'],
    [St.ClipboardType.PRIMARY, 'PRIMARY'],
]);

export default class ClipboardSyncExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._textDecoder = new TextDecoder();
        this._clipboard = null;
        this._selectionSignalId = 0;
        this._suppressedSelections = new Set();
        this._latestState = new Map();

        this._nodeId = null;
        this._server = null;
        this._pollId = 0;
        this._settingsSignals = [];
        this._localWatchId = 0;
        this._observedText = new Map();

        this._ensureNodeId();

        this._clipboard = St.Clipboard.get_default();
        try {
            // GNOME 46+ uses 'owner-changed'
            this._selectionSignalId = this._clipboard.connect('owner-changed', this._onOwnerChange.bind(this));
        } catch (error) {
            this._log(`Clipboard signal unavailable (${error.message}); falling back to local polling`);
            this._startLocalWatch();
        }

        this._startServer();
        this._updatePolling();

        this._settingsSignals = [
            this._settings.connect('changed::listen-port', () => this._restartServer()),
            this._settings.connect('changed::poll-interval', () => this._updatePolling()),
            this._settings.connect('changed::sync-primary', () => {}),
        ];
    }

    disable() {
        this._clearPolling();
        this._stopServer();
        this._stopLocalWatch();

        for (const id of this._settingsSignals) {
            this._settings.disconnect(id);
        }
        this._settingsSignals = [];

        if (this._clipboard && this._selectionSignalId) {
            this._clipboard.disconnect(this._selectionSignalId);
        }
        this._clipboard = null;
        this._selectionSignalId = 0;
        this._textDecoder = null;
        this._settings = null;
        this._suppressedSelections.clear();
        this._latestState.clear();
        this._observedText.clear();
        this._nodeId = null;
    }

    _ensureNodeId() {
        const existing = this._settings.get_string('node-id');
        if (existing && existing.trim().length > 0) {
            this._nodeId = existing;
            return;
        }
        this._nodeId = GLib.uuid_string_random();
        this._settings.set_string('node-id', this._nodeId);
    }

    _restartServer() {
        this._stopServer();
        this._startServer();
    }

    _startServer() {
        this._stopServer();

        const port = this._settings.get_int('listen-port');
        if (port <= 0 || port > 65535) {
            this._log(`Invalid listen port: ${port}`);
            return;
        }

        try {
            this._server = new Gio.SocketService();
            this._server.add_inet_port(port, null);
            this._server.connect('incoming', this._handleIncoming.bind(this));
            this._server.start();
            this._log(`Listening for clipboard updates on port ${port}`);
        } catch (error) {
            this._log(`Failed to start server: ${error.message}`);
            this._server = null;
        }
    }

    _stopServer() {
        if (this._server) {
            try {
                this._server.stop();
            } catch (error) {
                this._log(`Error stopping server: ${error.message}`);
            }
            this._server = null;
        }
    }

    _handleIncoming(_listener, connection) {
        this._processIncoming(connection).catch(error => {
            this._log(`Failed processing incoming connection: ${error.message}`);
        });
        return true;
    }

    async _processIncoming(connection) {
        const input = connection.get_input_stream();
        const dataInput = new Gio.DataInputStream({ base_stream: input });
        let response = { status: 'ignored' };

        try {
            const [line] = await dataInput.read_line_async(GLib.PRIORITY_DEFAULT, null);
            if (!line) {
                return;
            }
            const payloadText = this._textDecoder.decode(line);
            const payload = JSON.parse(payloadText);
            response = await this._handlePayload(payload);
        } catch (error) {
            this._log(`Error reading payload: ${error.message}`);
            response = { status: 'error', message: error.message };
        } finally {
            const output = connection.get_output_stream();
            try {
                const reply = JSON.stringify(response) + '\n';
                const bytes = new TextEncoder().encode(reply);
                await output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null);
                await output.close_async(GLib.PRIORITY_DEFAULT, null);
            } catch (error) {
                this._log(`Error sending reply: ${error.message}`);
            }

            try {
                connection.close(null);
            } catch (error) {
                this._log(`Error closing connection: ${error.message}`);
            }
        }
    }

    async _handlePayload(payload) {
        if (!payload || typeof payload !== 'object') {
            return { status: 'error', message: 'Invalid payload' };
        }

        const expectedSecret = this._settings.get_string('shared-secret') || '';
        if (payload.secret !== expectedSecret) {
            return { status: 'unauthorized' };
        }

        const type = payload.type || 'update';
        if (type === 'update') {
            const selection = this._selectionFromKey(payload.selection);
            if (!selection) {
                return { status: 'error', message: 'Unknown selection' };
            }

            const timestamp = Number(payload.timestamp) || Date.now();
            const sourceNode = payload.node || 'remote';
            const text = typeof payload.text === 'string' ? payload.text : '';

            if (!this._shouldAcceptUpdate(selection, timestamp, sourceNode, text)) {
                return { status: 'ignored' };
            }

            this._setClipboardFromRemote(selection, text);
            this._recordState(selection, text, timestamp, sourceNode);
            return { status: 'ok' };
        }

        if (type === 'pull') {
            const state = this._latestState.get(payload.selection || 'CLIPBOARD');
            if (!state) {
                return { status: 'empty' };
            }

            return {
                status: 'ok',
                type: 'update',
                node: this._nodeId,
                selection: payload.selection || 'CLIPBOARD',
                timestamp: state.timestamp,
                text: state.text,
            };
        }

        return { status: 'error', message: `Unsupported payload type: ${type}` };
    }

    _selectionFromKey(key) {
        for (const [selection, name] of SELECTION_KEYS.entries()) {
            if (name === key) {
                if (selection === St.ClipboardType.PRIMARY && !this._settings.get_boolean('sync-primary')) {
                    return null;
                }
                return selection;
            }
        }
        return null;
    }

    _selectionKey(selection) {
        return SELECTION_KEYS.get(selection) || 'CLIPBOARD';
    }

    _shouldAcceptUpdate(selection, timestamp, sourceNode, text) {
        const key = this._selectionKey(selection);
        const current = this._latestState.get(key);

        if (sourceNode === this._nodeId) {
            return false;
        }
        if (!current) {
            return true;
        }
        if (timestamp < current.timestamp) {
            return false;
        }
        if (timestamp === current.timestamp && text === current.text) {
            return false;
        }
        return true;
    }

    _setClipboardFromRemote(selection, text) {
        const key = this._selectionKey(selection);
        this._suppressedSelections.add(key);
        this._clipboard.set_text(selection, text);
    }

    _recordState(selection, text, timestamp, node) {
        const key = this._selectionKey(selection);
        this._latestState.set(key, { text, timestamp, node });
    }

    _onOwnerChange(_clipboard, selection) {
        // Если сигнал не передаёт selection, используем опрос
        if (typeof selection !== 'number') {
            this._checkLocalClipboard();
            return;
        }

        const key = this._selectionKey(selection);
        if (selection === St.ClipboardType.PRIMARY && !this._settings.get_boolean('sync-primary')) {
            return;
        }
        if (this._suppressedSelections.has(key)) {
            this._suppressedSelections.delete(key);
            return;
        }

        this._clipboard.get_text(selection, (_clip, text) => {
            if (typeof text !== 'string') {
                return;
            }
            this._publishClipboard(selection, text);
        });
    }

    _startLocalWatch() {
        if (this._localWatchId) {
            return;
        }
        this._localWatchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._checkLocalClipboard();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLocalWatch() {
        if (this._localWatchId) {
            GLib.source_remove(this._localWatchId);
            this._localWatchId = 0;
        }
    }

    _checkLocalClipboard() {
        const selections = [St.ClipboardType.CLIPBOARD];
        if (this._settings.get_boolean('sync-primary')) {
            selections.push(St.ClipboardType.PRIMARY);
        }
        for (const selection of selections) {
            const key = this._selectionKey(selection);
            this._clipboard.get_text(selection, (_clip, text) => {
                if (typeof text !== 'string') {
                    return;
                }
                if (this._suppressedSelections.has(key)) {
                    this._suppressedSelections.delete(key);
                    this._observedText.set(key, text);
                    return;
                }
                const prev = this._observedText.get(key);
                if (prev === text) {
                    return;
                }
                this._observedText.set(key, text);
                this._publishClipboard(selection, text);
            });
        }
    }

    _publishClipboard(selection, text) {
        const timestamp = Date.now();
        this._recordState(selection, text, timestamp, this._nodeId);

        const payload = {
            type: 'update',
            node: this._nodeId,
            selection: this._selectionKey(selection),
            timestamp,
            text,
            secret: this._settings.get_string('shared-secret') || '',
        };

        this._sendMessage(payload).catch(error => {
            this._log(`Failed to push clipboard: ${error.message}`);
        });
    }

    async _sendMessage(payload, expectResponse = false) {
        const endpoint = this._settings.get_string('peer-endpoint');
        if (!endpoint) {
            return null;
        }

        let uri;
        try {
            uri = GLib.Uri.parse(endpoint, GLib.UriFlags.NONE);
        } catch (error) {
            this._log(`Invalid peer endpoint: ${endpoint}`);
            return null;
        }

        const host = uri.get_host();
        let port = uri.get_port();
        if (port === -1) {
            port = this._settings.get_int('listen-port');
        }

        if (!host || port <= 0 || port > 65535) {
            this._log(`Incomplete peer endpoint: ${endpoint}`);
            return null;
        }

        const address = Gio.NetworkAddress.new(host, port);

        try {
            const client = new Gio.SocketClient();
            const connection = await client.connect_async(address, null);
            const message = JSON.stringify(payload) + '\n';
            const output = connection.get_output_stream();
            const bytes = new TextEncoder().encode(message);
            await output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null);

            let response = null;
            if (expectResponse) {
                const dataInput = new Gio.DataInputStream({ base_stream: connection.get_input_stream() });
                const [line] = await dataInput.read_line_async(GLib.PRIORITY_DEFAULT, null);
                if (line) {
                    response = JSON.parse(this._textDecoder.decode(line));
                }
            }

            await output.close_async(GLib.PRIORITY_DEFAULT, null);
            connection.close(null);
            return response;
        } catch (error) {
            this._log(`Connection to peer failed: ${error.message}`);
            return null;
        }
    }

    _updatePolling() {
        this._clearPolling();
        const interval = this._settings.get_int('poll-interval');
        if (interval <= 0) {
            return;
        }
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._pollRemote().catch(error => this._log(`Polling failed: ${error.message}`));
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearPolling() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    async _pollRemote() {
        const payload = {
            type: 'pull',
            node: this._nodeId,
            selection: 'CLIPBOARD',
            timestamp: Date.now(),
            secret: this._settings.get_string('shared-secret') || '',
        };

        const response = await this._sendMessage(payload, true);
        if (response && response.status === 'ok' && response.type === 'update') {
            const selection = this._selectionFromKey(response.selection);
            if (!selection) {
                return;
            }
            if (!this._shouldAcceptUpdate(selection, response.timestamp, response.node, response.text)) {
                return;
            }
            this._setClipboardFromRemote(selection, response.text);
            this._recordState(selection, response.text, response.timestamp, response.node);
        }
    }
    _log(message, level = 'debug') {
        const fn = console[level] || console.debug;
        fn.call(console, `[ClipboardSync] ${message}`);
 }
 
}
