export function openSidePanel(panel, button, returnFocus = null) {
  if (!panel.classList.contains("is-open")) {
    returnFocus = document.activeElement === document.body ? button : document.activeElement;
  }
  panel.classList.add("is-open");
  panel.inert = false;
  panel.setAttribute("aria-hidden", "false");
  button.setAttribute("aria-expanded", "true");
  return returnFocus;
}

export function closeSidePanel(panel, button, returnFocus, { restoreFocus = true } = {}) {
  const containedFocus = panel.contains(document.activeElement);
  panel.classList.remove("is-open");
  panel.inert = true;
  panel.setAttribute("aria-hidden", "true");
  button.setAttribute("aria-expanded", "false");
  if (restoreFocus && containedFocus) returnFocus?.focus?.();
}

export function showUiToast(message, { error = false, duration = 3_200 } = {}) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", error);
  toast.hidden = false;
  window.clearTimeout(toast.hideTimer);
  toast.hideTimer = window.setTimeout(() => {
    toast.hidden = true;
    toast.classList.remove("is-error");
  }, duration);
}

export function confirmUiAction(message, {
  dialog = globalThis.document?.querySelector("#confirmationDialog"),
  suspendedDialog = globalThis.document?.querySelector("dialog[open]:not(#confirmationDialog)"),
} = {}) {
  if (!dialog || dialog.open) return Promise.resolve(false);
  const messageNode = dialog.querySelector("[data-confirmation-message]");
  if (!messageNode) return Promise.resolve(false);
  messageNode.textContent = message;
  dialog.returnValue = "";
  return new Promise((resolve) => {
    const restoreSuspendedDialog = () => {
      if (suspendedDialog && suspendedDialog !== dialog && !suspendedDialog.open) suspendedDialog.showModal();
    };
    const finish = () => {
      const confirmed = dialog.returnValue === "confirm";
      if (!confirmed) restoreSuspendedDialog();
      resolve(confirmed);
    };
    dialog.addEventListener("close", finish, { once: true });
    try {
      if (suspendedDialog && suspendedDialog !== dialog) suspendedDialog.close();
      dialog.showModal();
    } catch {
      dialog.removeEventListener("close", finish);
      restoreSuspendedDialog();
      resolve(false);
    }
  });
}
