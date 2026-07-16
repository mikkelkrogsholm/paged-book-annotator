import assert from "node:assert/strict";
import test from "node:test";

import { confirmUiAction } from "./ui-state.js";

class FakeDialog extends EventTarget {
  constructor() {
    super();
    this.message = { textContent: "" };
    this.open = false;
    this.returnValue = "";
  }

  querySelector(selector) {
    return selector === "[data-confirmation-message]" ? this.message : null;
  }

  showModal() {
    this.open = true;
  }

  close(returnValue) {
    this.open = false;
    this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  }
}

test("application confirmation resolves true only for the explicit confirm action", async () => {
  const confirmedDialog = new FakeDialog();
  const confirmed = confirmUiAction("Publicér?", { dialog: confirmedDialog });
  assert.equal(confirmedDialog.open, true);
  assert.equal(confirmedDialog.message.textContent, "Publicér?");
  confirmedDialog.close("confirm");
  assert.equal(await confirmed, true);

  const cancelledDialog = new FakeDialog();
  const cancelled = confirmUiAction("Slet?", { dialog: cancelledDialog });
  cancelledDialog.close("cancel");
  assert.equal(await cancelled, false);
});

test("application confirmation fails closed without a usable dialog", async () => {
  assert.equal(await confirmUiAction("Slet?", { dialog: null }), false);
});
