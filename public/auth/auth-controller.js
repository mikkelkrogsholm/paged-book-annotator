import { AuthClient } from "./auth-client.js";

function formValue(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export class AuthController {
  constructor({ session, registration, bookId = "", client = new AuthClient({ bookId }) }) {
    this.session = session;
    this.registration = registration;
    this.bookId = bookId;
    this.client = client;
    this.dialog = document.querySelector("#authDialog");
    this.error = document.querySelector("#authError");
    this.bind();
    this.render();
  }

  bind() {
    document.querySelector("#accountButton").addEventListener("click", () => this.open());
    document.querySelector("#gateLoginButton").addEventListener("click", () => this.open());
    document.querySelector(".auth-tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-auth-view]");
      if (button) this.show(button.dataset.authView);
    });
    document.querySelectorAll("[data-auth-form]").forEach((form) => form.addEventListener("submit", (event) => this.submit(event)));
    document.querySelector("#logoutForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      await this.client.logout();
      window.location.reload();
    });
    document.querySelector("#exportAccountButton").addEventListener("click", async () => {
      const data = await this.client.exportAccount();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
      link.download = "paged-book-annotator-account.json";
      link.click();
      URL.revokeObjectURL(link.href);
    });
    document.querySelector("#eraseAccountButton").addEventListener("click", async () => {
      if (!window.confirm("Slet kontodata, læseprogression og adgang? Dine annotationer anonymiseres.")) return;
      await this.client.eraseAccount();
      window.location.reload();
    });
  }

  render() {
    const principal = this.session.principal;
    const account = document.querySelector("#accountButton");
    account.textContent = principal?.displayName || "Log ind";
    document.querySelector("#accountName").textContent = principal?.displayName ?? "";
    document.querySelector("#logoutForm").hidden = principal?.kind !== "user";
    document.querySelector("#accountTab").hidden = principal?.kind !== "user";
    document.querySelector("#registerTab").hidden = this.registration !== "open";
    document.querySelector("#codeTab").hidden = this.registration !== "code";
    document.querySelector("#adminLink").hidden = !this.session.capabilities.canManageUsers;
    if (this.bookId) document.querySelector("#adminLink").href = `/admin?book=${encodeURIComponent(this.bookId)}`;
    const invitation = new URLSearchParams(window.location.search).get("invite");
    if (invitation) {
      document.querySelector("#invitationSecret").value = invitation;
      this.show("invite");
      this.open();
    }
    const accessCode = new URLSearchParams(window.location.search).get("code");
    if (accessCode) {
      document.querySelector("#accessCodeSecret").value = accessCode;
      this.show("code");
      this.open();
    }
  }

  open() {
    this.error.hidden = true;
    this.dialog.showModal();
  }

  show(view) {
    if ((view === "register" && this.registration !== "open") || (view === "code" && this.registration !== "code")) view = "login";
    document.querySelectorAll("[data-auth-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.authView === view)));
    document.querySelectorAll("[data-auth-form]").forEach((form) => { form.hidden = form.dataset.authForm !== view; });
    document.querySelector("#authTitle").textContent = view === "login" ? "Log ind" : view === "register" ? "Opret bruger" : view === "password" ? "Konto og privatliv" : view === "code" ? "Brug adgangskode" : "Acceptér invitation";
    this.error.hidden = true;
  }

  async submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    this.error.hidden = true;
    try {
      const input = formValue(form);
      if (form.dataset.authForm === "login") await this.client.login(input);
      else if (form.dataset.authForm === "register") await this.client.register(input);
      else if (form.dataset.authForm === "password") await this.client.changePassword(input);
      else if (form.dataset.authForm === "code") await this.client.acceptAccessCode(input);
      else await this.client.acceptInvitation(input);
      window.location.reload();
    } catch (error) {
      this.error.textContent = error.message;
      this.error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  }
}
