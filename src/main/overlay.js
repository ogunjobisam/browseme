'use strict';

const path = require('node:path');
const { WebContentsView } = require('electron');

/**
 * The overlay layer.
 *
 * Page views sit on top of the browser chrome, so anything the chrome needs
 * to draw *over* a page — the omnibox dropdown, the Shields panel, the find
 * bar, permission prompts — cannot live in the chrome document. This is a
 * transparent view stacked above every tab that hosts those surfaces, which
 * is the same split Chrome itself uses between the browser window and its
 * popup widgets.
 *
 * It is hidden (and therefore click-through) whenever nothing is open.
 */

const OVERLAY_PRELOAD = path.join(__dirname, '..', 'preload', 'browser.js');
const OVERLAY_PAGE = path.join(__dirname, '..', 'renderer', 'overlay.html');

class Overlay {
  /** @param {Electron.BrowserWindow} window */
  constructor(window) {
    this.window = window;
    this.visible = false;
    this.kind = null;
    this._permissionSeq = 0;
    /** @type {Map<number, (allow: boolean) => void>} */
    this._pendingPermissions = new Map();

    this.view = new WebContentsView({
      webPreferences: {
        preload: OVERLAY_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        transparent: true,
        additionalArguments: ['--browseme-surface=chrome'],
      },
    });
    this.view.setBackgroundColor('#00000000');
    this.view.webContents.loadFile(OVERLAY_PAGE);

    window.contentView.addChildView(this.view);
    this.hide();
  }

  get webContents() {
    return this.view.webContents;
  }

  /** Keep the overlay above every tab view. */
  raise() {
    try {
      this.window.contentView.removeChildView(this.view);
      this.window.contentView.addChildView(this.view);
    } catch { /* window closing */ }
  }

  /**
   * @param {string} kind which surface to render
   * @param {object} payload data for that surface
   * @param {{x,y,width,height}} [bounds] region the overlay should occupy
   */
  show(kind, payload, bounds) {
    this.kind = kind;
    this.visible = true;
    this.raise();
    this.setBounds(bounds);
    if (typeof this.view.setVisible === 'function') this.view.setVisible(true);
    this.webContents.send('browseme:overlay', { type: 'render', kind, payload });
    return true;
  }

  hide() {
    this.visible = false;
    this.kind = null;
    if (typeof this.view.setVisible === 'function') this.view.setVisible(false);
    else this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.webContents.send('browseme:overlay', { type: 'clear' });
    return true;
  }

  setBounds(bounds) {
    const [width, height] = this.window.getContentSize();
    const target = bounds || { x: 0, y: 0, width, height };
    this.view.setBounds({
      x: Math.round(target.x ?? 0),
      y: Math.round(target.y ?? 0),
      width: Math.round(target.width ?? width),
      height: Math.round(target.height ?? height),
    });
  }

  /** Overlay UI reporting a user action back to the chrome UI. */
  handleAction(action, payload) {
    this.window.webContents.send('browseme:event', {
      type: 'overlay-action',
      payload: { action, payload },
    });
    return true;
  }

  /**
   * Ask the user to approve a permission. Resolves false if the window goes
   * away or the overlay is dismissed without an answer.
   * @returns {Promise<boolean>}
   */
  requestPermission({ permission, url, mode }) {
    return new Promise((resolve) => {
      const id = ++this._permissionSeq;
      this._pendingPermissions.set(id, resolve);

      const [width] = this.window.getContentSize();
      this.show('permission', { id, permission, url, mode }, {
        x: 0, y: 0, width, height: 260,
      });

      // Never leave a page hanging on an unanswered prompt.
      setTimeout(() => {
        if (this._pendingPermissions.delete(id)) resolve(false);
      }, 60_000);
    });
  }

  resolvePermission(id, allow) {
    const resolve = this._pendingPermissions.get(id);
    if (resolve) {
      this._pendingPermissions.delete(id);
      resolve(Boolean(allow));
    }
    this.hide();
    return true;
  }

  destroy() {
    for (const resolve of this._pendingPermissions.values()) resolve(false);
    this._pendingPermissions.clear();
    if (!this.webContents.isDestroyed()) this.webContents.close();
  }
}

module.exports = { Overlay };
