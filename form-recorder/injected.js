// Runs in the page's own JS world (world: MAIN). While the content script
// marks the document with data-ffr-auto (i.e. during auto-fill/autopilot),
// native alert/confirm dialogs are auto-answered with OK so they can't
// block the automation. At all other times the dialogs behave normally.

(() => {
  const origAlert = window.alert.bind(window);
  const origConfirm = window.confirm.bind(window);

  function autoMode() {
    return document.documentElement.hasAttribute("data-ffr-auto");
  }

  window.alert = function (msg) {
    if (autoMode()) return undefined;
    return origAlert(msg);
  };

  window.confirm = function (msg) {
    if (autoMode()) return true;
    return origConfirm(msg);
  };
})();
