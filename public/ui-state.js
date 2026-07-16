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
