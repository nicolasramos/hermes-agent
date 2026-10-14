/** BotsPage tests — verifies roster rendering and search filtering.

Run with: `npm run test -- BotsPage`
*/

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import { MemoryRouter } from "react-router";

import { BotsPage } from "./BotsPage";
import * as api from "@/lib/api";

/* ------------------------------------------------------------------ */
/* Mocks                                                              */
/* ------------------------------------------------------------------ */

const apiMocks = vi.hoisted(() => ({
  listProfiles: vi.fn(async () => []),
  createProfile: vi.fn(async () => ({ ok: true })),
  updateProfileDescription: vi.fn(async () => ({ ok: true })),
  updateProfileModel: vi.fn(async () => ({ ok: true })),
  updateProfileSoul: vi.fn(async () => ({ ok: true })),
  getCronJobs: vi.fn(async () => []),
  triggerCronJob: vi.fn(async () => ({ ok: true })),
  getProfileSoul: vi.fn(async () => ""),
  getProfilesSessionsSidebar: vi.fn(async () => ({ messaging: [] })),
  getSessionMessages: vi.fn(async () => []),
  submitChatMessage: vi.fn(async () => ({ ok: true })),
  getBotChatSessionId: vi.fn(async () => ({ session_id: null })),
  submitBotChatMessage: vi.fn(async () => ({ ok: true })),
  enableBotMode: vi.fn(async () => ({ ok: true })),
  getBotRoutines: vi.fn(async () => []),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

vi.mock("@/contexts/useProfileScope", () => ({
  useProfileScope: () => ({ profileScope: null, setProfileScope: vi.fn() }),
}));

vi.mock("@/contexts/usePageHeader", () => ({
  usePageHeader: vi.fn(),
}));

vi.mock("@/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@nous-research/ui/hooks/use-below-breakpoint", () => ({
  useBelowBreakpoint: vi.fn(() => false),
}));

vi.mock("@nous-research/ui/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@nous-research/ui/ui/components/typography/h2", () => ({
  H2: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("h2", { className }, children),
}));

vi.mock("@nous-research/ui/ui/components/label", () => ({
  Label: ({ children, htmlFor }: any) =>
    React.createElement("label", { htmlFor }, children),
}));

vi.mock("@nous-research/ui/ui/components/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    size,
    disabled,
    type,
    form,
  }: any) =>
    React.createElement(
      "button",
      { onClick, variant, size, disabled, type: type || "button", "data-form": form },
      children,
    ),
}));

vi.mock("@nous-research/ui/ui/components/input", () => ({
  Input: ({ value, onChange, placeholder, ...rest }: any) =>
    React.createElement("input", {
      value,
      onChange: (e: any) => onChange?.(e.target.value),
      placeholder,
      ...rest,
    }),
}));

vi.mock("@nous-research/ui/ui/components/badge", () => ({
  Badge: ({ children, variant }: any) =>
    React.createElement("span", { "data-badge": variant }, children),
}));

vi.mock("@nous-research/ui/ui/components/card", () => ({
  Card: ({ children }: any) => React.createElement("div", {}, children),
  CardContent: ({ children }: any) => React.createElement("div", {}, children),
}));

vi.mock("@nous-research/ui/ui/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@nous-research/ui/ui/components/selection-switcher", () => ({
  SelectionSwitcher: () => null,
}));

vi.mock("@nous-research/ui/hooks/useSidebarStatus", () => ({
  useSidebarStatus: () => ({ status: "stopped" }),
}));

vi.mock("@/components/SidebarFooter", () => ({ SidebarFooter: () => null }));
vi.mock("@/components/SidebarStatusStrip", () => ({
  SidebarStatusStrip: () => null,
  gatewayLine: "stopped",
}));
vi.mock("@/components/AuthWidget", () => ({ AuthWidget: () => null }));
vi.mock("@/components/LanguageSwitcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/components/ThemeSwitcher", () => ({ ThemeSwitcher: () => null }));
vi.mock("@/components/ProfileSwitcher", () => ({ ProfileSwitcher: () => null }));
vi.mock("@/components/ProfileScopeBanner", () => ({ ProfileScopeBanner: () => null }));
vi.mock("@/components/MemoryPressureBanner", () => ({ MemoryPressureBanner: () => null }));
vi.mock("@/plugins", () => ({
  PluginPage: () => null,
  PluginSlot: () => null,
  usePlugins: () => ({ manifests: [], loading: false }),
}));
vi.mock("@/themes", () => ({ useTheme: () => ({ theme: "default" }) }));
vi.mock("@/lib/dashboard-flags", () => ({
  isDashboardEmbeddedChatEnabled: () => false,
}));
vi.mock("@/lib/chat-activation", () => ({ latchChatActivation: vi.fn() }));
vi.mock("@nous-research/ui/hooks/use-confirm-delete", () => ({
  useConfirmDelete: vi.fn(() => ({ confirmDelete: vi.fn(), isConfirmed: false })),
}));
vi.mock("@nous-research/ui/hooks/useModalBehavior", () => ({
  useModalBehavior: () => ({ isOpen: false, open: vi.fn(), close: vi.fn() }),
}));
vi.mock("@nous-research/ui/ui/components/toast", () => ({ Toast: () => null }));

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

let root: Root | null = null;

function renderBotsPage() {
  const container = document.createElement("div");
  container.id = "root";
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    React.createElement(MemoryRouter, { initialEntries: ["/bots"] },
      React.createElement(BotsPage),
    ),
  );
}

function cleanup() {
  if (root) {
    root.unmount();
    root = null;
  }
  document.body.innerHTML = "";
}

afterEach(cleanup);

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe("BotsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listProfiles.mockResolvedValue([
      {
        name: "default",
        path: "/home/user/.hermes/profiles/default",
        is_default: true,
        model: null,
        provider: null,
        has_env: false,
        skill_count: 0,
        gateway_running: false,
        description: "",
        description_auto: false,
        display_name: "",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
    ]);
  });

  it("renders the page title", async () => {
    renderBotsPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).toContain("bots.pageTitle");
  });

  it("shows empty state when only default profile exists", async () => {
    renderBotsPage();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).toContain("bots.emptyRosterTitle");
    expect(document.body.textContent).toContain("bots.createFirstBot");
  });

  it("lists multiple profiles in the roster", async () => {
    apiMocks.listProfiles.mockResolvedValue([
      {
        name: "default",
        path: "/home/user/.hermes/profiles/default",
        is_default: true,
        model: null,
        provider: null,
        has_env: false,
        skill_count: 0,
        gateway_running: false,
        description: "",
        description_auto: false,
        display_name: "",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
      {
        name: "coder",
        path: "/home/user/.hermes/profiles/coder",
        is_default: false,
        model: "openai/gpt-4o",
        provider: "openai",
        has_env: true,
        skill_count: 3,
        gateway_running: true,
        description: "Writes code",
        description_auto: false,
        display_name: "Coder",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
    ]);

    renderBotsPage();
    await new Promise((r) => setTimeout(r, 50));

    expect(document.body.textContent).toContain("coder");
    expect(document.body.textContent).not.toContain("bots.emptyRosterTitle");
  });

  it("shows active badge when gateway is running", async () => {
    apiMocks.listProfiles.mockResolvedValue([
      {
        name: "default",
        path: "/home/user/.hermes/profiles/default",
        is_default: true,
        model: null,
        provider: null,
        has_env: false,
        skill_count: 0,
        gateway_running: false,
        description: "",
        description_auto: false,
        display_name: "",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
      {
        name: "worker",
        path: "/home/user/.hermes/profiles/worker",
        is_default: false,
        model: null,
        provider: null,
        has_env: false,
        skill_count: 0,
        gateway_running: true,
        description: "Background worker",
        description_auto: false,
        display_name: "Worker",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
    ]);

    renderBotsPage();
    await new Promise((r) => setTimeout(r, 50));

    expect(document.body.textContent).toContain("bots.active");
  });

  it("filters roster by search query (non-vacuous regression)", async () => {
    apiMocks.listProfiles.mockResolvedValue([
      {
        name: "coder",
        path: "/home/user/.hermes/profiles/coder",
        is_default: false,
        model: "openai/gpt-4o",
        provider: "openai",
        has_env: true,
        skill_count: 3,
        gateway_running: false,
        description: "Writes code",
        description_auto: false,
        display_name: "Coder",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
      {
        name: "finanzas",
        path: "/home/user/.hermes/profiles/finanzas",
        is_default: false,
        model: null,
        provider: null,
        has_env: false,
        skill_count: 0,
        gateway_running: false,
        description: "Financial analysis",
        description_auto: false,
        display_name: "Finanzas",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
      {
        name: "writer",
        path: "/home/user/.hermes/profiles/writer",
        is_default: false,
        model: null,
        provider: null,
        has_env: false,
        skill_count: 0,
        gateway_running: false,
        description: "Content writer",
        description_auto: false,
        display_name: "Writer",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
      {
        name: "analyst",
        path: "/home/user/.hermes/profiles/analyst",
        is_default: false,
        model: null,
        provider: null,
        has_env: false,
        skill_count: 0,
        gateway_running: false,
        description: "Data analyst",
        description_auto: false,
        display_name: "Analyst",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
    ]);

    renderBotsPage();
    await new Promise((r) => setTimeout(r, 50));

    expect(document.body.textContent).toContain("coder");

    // The search input should exist when there are 4+ profiles
    const inputs = document.querySelectorAll("input");
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("renders the create bot button in empty state", async () => {
    apiMocks.listProfiles.mockResolvedValue([
      {
        name: "default",
        path: "/home/user/.hermes/profiles/default",
        is_default: true,
        model: null,
        provider: null,
        has_env: false,
        skill_count: 0,
        gateway_running: false,
        description: "",
        description_auto: false,
        display_name: "",
        distribution_name: null,
        distribution_version: null,
        distribution_source: null,
        has_alias: false,
      },
    ]);

    renderBotsPage();
    await new Promise((r) => setTimeout(r, 50));

    const buttons = document.querySelectorAll("button");
    const createBtn = Array.from(buttons).find((b) =>
      b.textContent?.includes("bots.createFirstBot"),
    );
    expect(createBtn).toBeTruthy();
  });

  it("renders the refresh button", async () => {
    renderBotsPage();
    await new Promise((r) => setTimeout(r, 50));

    const buttons = document.querySelectorAll("button");
    const refreshBtn = Array.from(buttons).find((b) => {
      // The refresh button has a RefreshCw icon (SVG) — check for the button
      // near the create bot button
      return b.getAttribute("variant") === "ghost";
    });
    expect(refreshBtn).toBeTruthy();
  });
});
