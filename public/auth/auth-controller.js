import { AuthClient } from "./auth-client.js";

function formValue(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function consumeCredentialQuery(locationLike = window.location, historyLike = window.history) {
  const url = new URL(locationLike.href);
  const hasCredentialQuery = url.searchParams.has("invite") || url.searchParams.has("code");
  const credentials = {
    invitation: url.searchParams.get("invite"),
    accessCode: url.searchParams.get("code"),
  };
  if (hasCredentialQuery) {
    url.searchParams.delete("invite");
    url.searchParams.delete("code");
    historyLike.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return credentials;
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
    document.querySelector(".auth-tabs").addEventListener("keydown", (event) => this.navigateTabs(event));
    document.querySelectorAll("[data-auth-form]").forEach((form) => form.addEventListener("submit", (event) => this.submit(event)));
    document.querySelector("#logoutForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (await this.runAccountAction(event.submitter, () => this.client.logout())) window.location.reload();
    });
    document.querySelector("#exportAccountButton").addEventListener("click", async (event) => {
      await this.runAccountAction(event.currentTarget, async () => {
        const data = await this.client.exportAccount();
        const link = document.createElement("a");
        const objectUrl = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" }));
        link.href = objectUrl;
        link.download = "paged-book-annotator-account.json";
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      });
    });
    document.querySelector("#eraseAccountButton").addEventListener("click", async (event) => {
      if (!window.confirm("Slet kontodata, læseprogression og adgang? Dine annotationer anonymiseres.")) return;
      if (await this.runAccountAction(event.currentTarget, () => this.client.eraseAccount())) window.location.reload();
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
    const adminPermissions = new Set(this.session.capabilities.permissions ?? []);
    const canOpenAdmin = this.session.capabilities.canManageUsers || [
      "books:upload", "books:publish", "books:settings", "annotations:moderate", "annotations:export",
      "surveys:manage", "surveys:responses:read", "surveys:export", "progress:read:all", "users:read",
      "users:invite", "access:manage", "tokens:manage", "audit:read",
    ].some((permission) => adminPermissions.has(permission));
    document.querySelector("#adminLink").hidden = !canOpenAdmin;
    if (this.bookId) document.querySelector("#adminLink").href = `/admin?book=${encodeURIComponent(this.bookId)}`;
    this.show(principal?.kind === "user" ? "password" : "login");
    const { invitation, accessCode } = consumeCredentialQuery();
    if (invitation) {
      document.querySelector("#invitationSecret").value = invitation;
      this.show("invite");
      this.open();
    } else if (accessCode) {
      document.querySelector("#accessCodeSecret").value = accessCode;
      this.show("code");
      this.open();
    }
  }

  open() {
    this.error.hidden = true;
    if (!this.dialog.open) this.dialog.showModal();
  }

  show(view) {
    if ((view === "register" && this.registration !== "open") || (view === "code" && this.registration !== "code")) view = "login";
    document.querySelectorAll("[data-auth-view]").forEach((button) => {
      const active = button.dataset.authView === view;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-auth-form]").forEach((form) => { form.hidden = form.dataset.authForm !== view; });
    document.querySelector("#logoutForm").hidden = !(this.session.principal?.kind === "user" && view === "password");
    document.querySelector("#authTitle").textContent = view === "login" ? "Log ind" : view === "register" ? "Opret bruger" : view === "password" ? "Konto og privatliv" : view === "code" ? "Brug adgangskode" : "Acceptér invitation";
    this.error.hidden = true;
  }

  navigateTabs(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("[data-auth-view]:not([hidden])")];
    if (!tabs.length) return;
    const current = Math.max(0, tabs.indexOf(event.target.closest("[data-auth-view]")));
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    this.show(tabs[next].dataset.authView);
    tabs[next].focus();
  }

  async runAccountAction(button, action) {
    button.disabled = true;
    this.error.hidden = true;
    try {
      await action();
      return true;
    } catch (error) {
      this.error.textContent = error.message;
      this.error.hidden = false;
      return false;
    } finally {
      button.disabled = false;
    }
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
