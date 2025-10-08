'use strict';

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClipboardSyncPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.clipboard-sync');

        window._settings = settings;

        const page = new Adw.PreferencesPage();
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({ title: 'Clipboard Sync' });
        page.add(generalGroup);

        const peerRow = new Adw.EntryRow({
            title: 'Peer endpoint',
            text: settings.get_string('peer-endpoint'),
        });
        peerRow.connect('notify::text', row => {
            settings.set_string('peer-endpoint', row.text.trim());
        });
        peerRow.subtitle = 'Remote URI that receives clipboard updates (e.g. tcp://host:7100)';
        generalGroup.add(peerRow);

        const listenRow = new Adw.SpinRow({
            title: 'Listen port',
            adjustment: new Gtk.Adjustment({ lower: 1024, upper: 65535, step_increment: 1, page_increment: 100 }),
            value: settings.get_int('listen-port'),
        });
        listenRow.connect('notify::value', row => {
            settings.set_int('listen-port', row.value);
        });
        listenRow.subtitle = 'Local port used by the built-in sync server';
        generalGroup.add(listenRow);

        const secretRow = new Adw.EntryRow({
            title: 'Shared secret',
            text: settings.get_string('shared-secret'),
        });
        secretRow.connect('notify::text', row => {
            settings.set_string('shared-secret', row.text.trim());
        });
        secretRow.subtitle = 'Keep this value the same on both machines';
        generalGroup.add(secretRow);

        const pollRow = new Adw.SpinRow({
            title: 'Poll interval (seconds)',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 120, step_increment: 1, page_increment: 5 }),
            value: settings.get_int('poll-interval'),
        });
        pollRow.connect('notify::value', row => {
            settings.set_int('poll-interval', row.value);
        });
        pollRow.subtitle = 'Set to 0 to disable polling when push notifications are working';
        generalGroup.add(pollRow);

        const syncPrimaryRow = new Adw.SwitchRow({
            title: 'Sync primary selection',
            active: settings.get_boolean('sync-primary'),
        });
        syncPrimaryRow.connect('notify::active', row => {
            settings.set_boolean('sync-primary', row.active);
        });
        syncPrimaryRow.subtitle = 'Also synchronize the selection used for middle-click paste';
        generalGroup.add(syncPrimaryRow);
    }
}

function init() {
    return new ClipboardSyncPreferences();
}
