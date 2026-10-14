/** BotsPage tests — roster, Bot Chat hand-off, creation guard, detail + routines.
 *
 * Run with: `npm run test -- BotsPage`
 *
 * The "opens the Bot Chat session" test is the guard for criterion 2: it fails
 * if the row stops handing the backend's session id to `/chat`.
 */

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const apiMocks = vi.hoisted(() => ({
  listBots: vi.fn(),
  getSessions: vi.fn(),
  createBot: vi.fn(),
  updateBot: vi.fn(),
  updateProfileDescription: vi.fn(),
  setProfileModel: vi.fn(),
  updateProfileSoul: vi.fn(),
  getProfileSoul: vi.fn(),
  getSkills: vi.fn(),
  toggleSkill: vi.fn(),
  getMcpServers: vi.fn(),
  getCronJobs: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  triggerCronJob: vi.fn(),
  getModelOptions: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
  setManagementProfile: vi.fn(),
  getManagementProfile: vi.fn(() => ""),
}));
vi.mock("@/components/ModelPickerDialog", () => ({
  ModelPickerDialog: () => null,
}));
vi.mock("@nous-research/ui/ui/components/toast", () => ({ Toast: () => null }));

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let currentPath = "";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function LocationProbe() {
  const location = useLocation();
  currentPath = `${location.pathname}${location.search}`;
  return null;
}

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function click(el: Element | null) {
  if (!el) throw new Error("element not rendered");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function byTestId(id: string) {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function renderPage() {
  const [{ default: BotsPage }, { I18nProvider }, { PageHeaderProvider }] = await Promise.all([
    import("./BotsPage"),
    import("@/i18n"),
    import("@/contexts/PageHeaderProvider"),
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/bots"]}>
          <LocationProbe />
          <PageHeaderProvider pluginTabs={[]}>
            <BotsPage />
          </PageHeaderProvider>
        </MemoryRouter>
      </I18nProvider>,
    ),
  );
}

function bot(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    bot_managed: true,
    title: name,
    description: `role of ${name}`,
    model: "gpt-4o",
    provider: "openai",
    bot_chat_session_id: `sid-${name}`,
    ...extra,
  };
}

/** Per-profile "most recent session" fixtures, keyed by profile name. */
function stubSessions(latest: Record<string, { last_active: number; preview: string } | null>) {
  apiMocks.getSessions.mockImplementation(
    async (_limit: number, _offset: number, profile: string) => {
      const row = latest[profile];
      return {
        sessions: row
          ? [
              {
                id: `sess-${profile}`,
                profile,
                title: "Bot Chat",
                last_active: row.last_active,
                preview: row.preview,
              },
            ]
          : [],
        total: row ? 1 : 0,
        limit: 1,
        offset: 0,
      };
    },
  );
}

function rowOrder(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='open-chat-']")).map((el) =>
    el.getAttribute("data-testid")!.replace("open-chat-", ""),
  );
}

beforeEach(() => {
  for (const fn of Object.values(apiMocks)) fn.mockReset();
  currentPath = "";
  apiMocks.listBots.mockResolvedValue({ bots: [] });
  apiMocks.getSessions.mockResolvedValue({ sessions: [], total: 0, limit: 1, offset: 0 });
  apiMocks.getProfileSoul.mockResolvedValue({ content: "", exists: false });
  apiMocks.getSkills.mockResolvedValue([]);
  apiMocks.getMcpServers.mockResolvedValue({ servers: [] });
  apiMocks.getCronJobs.mockResolvedValue([]);
  apiMocks.updateProfileDescription.mockResolvedValue({ ok: true, description: "" });
  apiMocks.updateBot.mockResolvedValue({ ok: true });
  apiMocks.setProfileModel.mockResolvedValue({ ok: true });
  apiMocks.createBot.mockResolvedValue({ ok: true, bot_chat_session_id: "sid-new" });
  vi.stubGlobal("matchMedia", () => ({
    addEventListener() {},
    removeEventListener() {},
    matches: false,
    media: "",
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("Bots roster", () => {
  it("lists every profile with its title and role, ordered by recent activity", async () => {
    const now = Math.floor(Date.now() / 1000);
    apiMocks.listBots.mockResolvedValue({
      bots: [bot("default"), bot("alpha"), bot("beta")],
    });
    stubSessions({
      default: { last_active: now - 5000, preview: "old" },
      alpha: { last_active: now - 4000, preview: "alpha says hi" },
      beta: { last_active: now - 10, preview: "beta is typing" },
    });

    await renderPage();
    await waitFor(() => rowOrder().length === 3);

    expect(apiMocks.listBots).toHaveBeenCalledTimes(1);
    // Same set as `hermes profile list`, sorted by most recent activity.
    expect(rowOrder()).toEqual(["beta", "alpha", "default"]);
    const text = document.body.textContent ?? "";
    expect(text).toContain("role of beta");
    expect(text).toContain("beta is typing");
    // Wrote less than 90 s ago → working badge; the others stay quiet.
    expect(byTestId("working-beta")).toBeTruthy();
    expect(byTestId("working-alpha")).toBeNull();
  });

  it("shows the empty state with the create action when only `default` exists", async () => {
    apiMocks.listBots.mockResolvedValue({ bots: [bot("default")] });

    await renderPage();
    await waitFor(() => Boolean(byTestId("create-first-bot")));

    expect(document.body.textContent).toContain("No bots yet");
    expect(rowOrder()).toEqual([]);
  });

  it("filters the roster by search query", async () => {
    apiMocks.listBots.mockResolvedValue({ bots: [bot("alpha"), bot("beta")] });
    stubSessions({ alpha: null, beta: null });

    await renderPage();
    await waitFor(() => rowOrder().length === 2);

    const search = document.querySelector<HTMLInputElement>('[data-testid="bot-search"]');
    if (!search) throw new Error("search input not rendered");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "beta",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(rowOrder()).toEqual(["beta"]);
  });
});

describe("Opening the Bot Chat", () => {
  it("hands the backend's Bot Chat session id to /chat, scoped to the bot profile", async () => {
    apiMocks.listBots.mockResolvedValue({ bots: [bot("alpha", { bot_chat_session_id: "sid-42" })] });
    stubSessions({ alpha: null });

    await renderPage();
    await waitFor(() => Boolean(byTestId("open-chat-alpha")));

    await act(async () => click(byTestId("open-chat-alpha")));

    expect(currentPath).toBe("/chat?resume=sid-42&profile=alpha");
  });

  it("refuses to navigate when the backend reports no Bot Chat session", async () => {
    apiMocks.listBots.mockResolvedValue({
      bots: [bot("alpha", { bot_chat_session_id: null })],
    });
    stubSessions({ alpha: null });

    await renderPage();
    await waitFor(() => Boolean(byTestId("open-chat-alpha")));

    await act(async () => click(byTestId("open-chat-alpha")));

    expect(currentPath).toBe("/bots");
  });
});

describe("Creating a bot", () => {
  it("shows the API detail and keeps the dialog open when the name is taken", async () => {
    apiMocks.listBots.mockResolvedValue({ bots: [bot("alpha")] });
    stubSessions({ alpha: null });
    apiMocks.createBot.mockRejectedValue(
      new Error('409: {"detail":"Profile \'alpha\' already exists"}'),
    );

    await renderPage();
    await waitFor(() => Boolean(byTestId("new-bot")));

    await act(async () => click(byTestId("new-bot")));
    const nameInput = document.querySelector<HTMLInputElement>('[data-testid="create-name"]');
    if (!nameInput) throw new Error("name input not rendered");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        nameInput,
        "alpha",
      );
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => click(byTestId("create-submit")));
    await waitFor(() => Boolean(byTestId("create-error")));

    expect(byTestId("create-error")!.textContent).toContain("Profile 'alpha' already exists");
    expect(apiMocks.createBot).toHaveBeenCalledTimes(1);
    // Dialog stays open — nothing was created.
    expect(byTestId("create-dialog")).toBeTruthy();
  });
});

describe("Bot detail", () => {
  it("saves the role through the profile description endpoint (profile.yaml / CLI)", async () => {
    apiMocks.listBots.mockResolvedValue({ bots: [bot("alpha")] });
    stubSessions({ alpha: null });

    await renderPage();
    await waitFor(() => Boolean(byTestId("open-detail-alpha")));
    await act(async () => click(byTestId("open-detail-alpha")));
    await waitFor(() => Boolean(byTestId("bot-role")));

    const role = document.querySelector<HTMLTextAreaElement>('[data-testid="bot-role"]');
    if (!role) throw new Error("role field not rendered");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        role,
        "Answers support tickets",
      );
      role.dispatchEvent(new Event("textarea", { bubbles: true }));
      role.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => click(byTestId("detail-save")));
    await waitFor(() => apiMocks.updateProfileDescription.mock.calls.length > 0);

    expect(apiMocks.updateProfileDescription).toHaveBeenCalledWith(
      "alpha",
      "Answers support tickets",
    );
    // Bot-Mode profiles keep their ui_meta block in sync with the same value.
    expect(apiMocks.updateBot).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ description: "Answers support tickets" }),
    );
  });

  it("lists the bot's routines and resumes a paused one", async () => {
    apiMocks.listBots.mockResolvedValue({ bots: [bot("alpha")] });
    stubSessions({ alpha: null });
    apiMocks.getCronJobs.mockResolvedValue([
      {
        id: "job-1",
        name: "Nightly digest",
        enabled: false,
        state: "paused",
        schedule_display: "0 3 * * *",
      },
    ]);
    apiMocks.resumeCronJob.mockResolvedValue({ id: "job-1", enabled: true, state: "scheduled" });

    await renderPage();
    await waitFor(() => Boolean(byTestId("open-detail-alpha")));
    await act(async () => click(byTestId("open-detail-alpha")));
    await waitFor(() => Boolean(byTestId("routine-job-1")));

    expect(document.body.textContent).toContain("Nightly digest");
    expect(apiMocks.getCronJobs).toHaveBeenCalledWith("alpha");

    await act(async () => click(byTestId("routine-toggle-job-1")));
    await waitFor(() => apiMocks.resumeCronJob.mock.calls.length > 0);

    expect(apiMocks.resumeCronJob).toHaveBeenCalledWith("job-1", "alpha");
  });
});
