/** Bots surface — roster, Bot Chat entry point, bot detail sheet and routines.
 *
 * Boundary (E3 of NRA-4434): `web/src/**` only. The Bot Mode API is owned by
 * E1 (`hermes_cli/web_routers/bots.py`) and consumed here as-is; everything
 * else (profiles, skills, cron, sessions) uses the endpoints that already
 * exist. Nothing on this page invents a route.
 *
 * Chat is deliberately NOT rebuilt: tapping a row hands the bot's canonical
 * `Bot Chat` session to the embedded TUI (`/chat?resume=<id>` scoped to the
 * bot's profile), which is the dashboard's one chat surface (web/AGENTS.md).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import type { BotRosterEntry, CronJob, McpServer, SkillInfo } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { ModelPickerDialog } from "@/components/ModelPickerDialog";
import { useI18n } from "@/i18n";
import { usePageHeader } from "@/contexts/usePageHeader";

/* ------------------------------------------------------------------ */
/* Types + helpers                                                     */
/* ------------------------------------------------------------------ */

/** A roster entry enriched with the profile's most recent session. */
interface BotRow extends BotRosterEntry {
  preview: string | null;
  last_active: number | null;
}

/** "Working" = the bot wrote in the last ~90 seconds (roster row, criterion 1). */
const WORKING_WINDOW_S = 90;

function isWorking(lastActive: number | null): boolean {
  if (lastActive === null) return false;
  return Date.now() / 1000 - lastActive < WORKING_WINDOW_S;
}

function avatarColor(name: string): string {
  const colors = [
    "bg-blue-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-purple-500",
    "bg-rose-500",
    "bg-cyan-500",
    "bg-indigo-500",
    "bg-teal-500",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/** `fetchJSON` throws `${status}: ${body}`; surface FastAPI's `detail`. */
function apiErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const detail = raw.match(/"detail"\s*:\s*"([^"]*)"/);
  if (detail) return detail[1];
  const bare = raw.replace(/^\d+:\s*/, "").trim();
  return bare || fallback;
}

/* ------------------------------------------------------------------ */
/* Avatar                                                              */
/* ------------------------------------------------------------------ */

function BotAvatar({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClass =
    size === "lg"
      ? "h-12 w-12 text-lg"
      : size === "sm"
        ? "h-8 w-8 text-sm"
        : "h-10 w-10 text-base";
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        avatarColor(name),
        sizeClass,
      )}
      aria-hidden="true"
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

function EmptyRoster({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="rounded-full bg-muted p-4">
        <Bot className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-muted-foreground">{t.bots.emptyRosterTitle}</h3>
        <p className="text-sm text-muted-foreground">{t.bots.emptyRosterDesc}</p>
      </div>
      <Button onClick={onCreate} data-testid="create-first-bot">
        <Sparkles className="mr-2 h-4 w-4" />
        {t.bots.createFirstBot}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create-bot dialog                                                   */
/* ------------------------------------------------------------------ */

function CreateBotDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setError(null);
      setCreating(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return;
    setCreating(true);
    try {
      await onCreate(trimmed, description.trim());
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, t.bots.createFailed));
    } finally {
      setCreating(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4">
      <div
        className="w-full max-w-md rounded-t-2xl bg-popover p-6 shadow-lg sm:rounded-xl"
        role="dialog"
        aria-modal="true"
        aria-label={t.bots.createBotTitle}
        data-testid="create-dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3>{t.bots.createBotTitle}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t.common.close}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
              data-testid="create-error"
            >
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="bot-name">{t.bots.profileName}</Label>
            <Input
              id="bot-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my_bot"
              required
              maxLength={64}
              autoComplete="off"
              data-testid="create-name"
            />
            <p className="text-xs text-muted-foreground">{t.bots.nameHint}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bot-desc">{t.bots.profileDescription}</Label>
            <textarea
              id="bot-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.bots.descriptionPlaceholder}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="create-description"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" outlined onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={creating || !name.trim()} data-testid="create-submit">
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t.bots.createBot}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Roster row                                                          */
/* ------------------------------------------------------------------ */

function RosterRow({
  bot,
  onOpenChat,
  onOpenDetail,
}: {
  bot: BotRow;
  onOpenChat: (bot: BotRow) => void;
  onOpenDetail: (bot: BotRow) => void;
}) {
  const { t } = useI18n();
  const title = bot.title || bot.name;
  const working = isWorking(bot.last_active);

  return (
    <div className="flex items-stretch gap-1">
      <button
        onClick={() => onOpenChat(bot)}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-xl p-3 text-left transition-colors hover:bg-muted/60"
        aria-label={`${title} — ${t.bots.openChat}`}
        data-testid={`open-chat-${bot.name}`}
      >
        <BotAvatar name={bot.name} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{title}</span>
            {working && (
              <Badge tone="success" data-testid={`working-${bot.name}`}>
                {t.bots.working}
              </Badge>
            )}
          </div>
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {bot.description || t.bots.noRole}
          </p>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="truncate">{bot.preview || t.bots.noMessages}</span>
            {bot.last_active !== null && (
              <span className="shrink-0 whitespace-nowrap">{timeAgo(bot.last_active)}</span>
            )}
          </div>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      <button
        onClick={() => onOpenDetail(bot)}
        className="my-2 shrink-0 rounded-lg px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`${title} — ${t.bots.details}`}
        title={t.bots.details}
        data-testid={`open-detail-${bot.name}`}
      >
        <Settings2 className="h-5 w-5" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Routines (cron)                                                     */
/* ------------------------------------------------------------------ */

function jobPaused(job: CronJob): boolean {
  return (job.state || "").toLowerCase() === "paused" || job.enabled === false;
}

function RoutinesSection({ profileName }: { profileName: string }) {
  const { t } = useI18n();
  const { toast, showToast } = useToast();
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getCronJobs(profileName)
      .then(setJobs)
      .catch((err) => {
        setJobs([]);
        showToast(apiErrorMessage(err, t.bots.routinesFailed), "error");
      });
  }, [profileName, showToast, t.bots.routinesFailed]);

  useEffect(() => {
    setJobs(null);
    load();
  }, [load]);

  const act = async (job: CronJob, kind: "pause" | "resume" | "trigger") => {
    setBusyId(job.id);
    try {
      if (kind === "pause") await api.pauseCronJob(job.id, profileName);
      else if (kind === "resume") await api.resumeCronJob(job.id, profileName);
      else await api.triggerCronJob(job.id, profileName);
      showToast(
        kind === "trigger"
          ? t.bots.jobTriggered
          : kind === "pause"
            ? t.bots.jobPaused
            : t.bots.jobResumed,
        "success",
      );
      if (kind !== "trigger") load();
    } catch (err) {
      showToast(apiErrorMessage(err, t.bots.jobFailed), "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="routines">
      <h3 className="text-base">{t.bots.routines}</h3>
      <Toast toast={toast} />
      {jobs === null ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Spinner aria-label={t.common.loading} />
          {t.common.loading}
        </div>
      ) : jobs.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t.bots.noRoutines}</p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => {
            const paused = jobPaused(job);
            const busy = busyId === job.id;
            const label = job.schedule_display || job.schedule?.display || t.bots.scheduleManual;
            return (
              <div
                key={job.id}
                className="flex items-center justify-between gap-2 rounded-lg border p-3"
                data-testid={`routine-${job.id}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{job.name || job.id}</p>
                  <p className="truncate text-xs text-muted-foreground">{label}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {paused && <Badge tone="warning">{t.bots.paused}</Badge>}
                  <Button
                    outlined
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(job, paused ? "resume" : "pause")}
                    aria-label={paused ? t.bots.resume : t.bots.pause}
                    title={paused ? t.bots.resume : t.bots.pause}
                    data-testid={`routine-toggle-${job.id}`}
                  >
                    {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(job, "trigger")}
                    aria-label={t.bots.triggerNow}
                    title={t.bots.triggerNow}
                    data-testid={`routine-trigger-${job.id}`}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bot detail sheet                                                    */
/* ------------------------------------------------------------------ */

interface DetailForm {
  title: string;
  description: string;
  provider: string;
  model: string;
  soul: string;
}

function BotDetailSheet({
  bot,
  onClose,
  onSaved,
}: {
  bot: BotRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { toast, showToast } = useToast();
  const [form, setForm] = useState<DetailForm>({
    title: bot.title || bot.name,
    description: bot.description || "",
    provider: bot.provider || "",
    model: bot.model || "",
    soul: "",
  });
  const [saving, setSaving] = useState(false);
  const [soulLoading, setSoulLoading] = useState(true);
  const [soulDirty, setSoulDirty] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServer[] | null>(null);
  const [showSkills, setShowSkills] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getProfileSoul(bot.name)
      .then((res) => {
        if (!cancelled) {
          setForm((f) => ({ ...f, soul: res.content || "" }));
          setSoulLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setSoulLoading(false);
      });
    api
      .getSkills(bot.name)
      .then((res) => {
        if (!cancelled) setSkills(res);
      })
      .catch(() => {
        if (!cancelled) setSkills([]);
      });
    api
      .getMcpServers()
      .then((res) => {
        if (!cancelled) setMcpServers(res.servers);
      })
      .catch(() => {
        if (!cancelled) setMcpServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.name]);

  const toggleSkill = async (skill: SkillInfo, enabled: boolean) => {
    try {
      await api.toggleSkill(skill.name, enabled, bot.name);
      setSkills((prev) => (prev || []).map((s) => (s.name === skill.name ? { ...s, enabled } : s)));
    } catch (err) {
      showToast(apiErrorMessage(err, t.bots.saveFailed), "error");
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const role = form.description.trim();
      // The role lives in the profile's own meta — that is what
      // `hermes profile list` shows — and, for Bot-Mode profiles, in the
      // ui_meta block E1's roster reads, so both stay in sync (criterion 5).
      await api.updateProfileDescription(bot.name, role);

      const patch: { title?: string; description?: string; model?: string; provider?: string } = {
        description: role,
      };
      const title = form.title.trim();
      if (bot.bot_managed && title && title !== bot.title) patch.title = title;
      if (
        form.provider &&
        form.model &&
        (form.provider !== bot.provider || form.model !== bot.model)
      ) {
        await api.setProfileModel(bot.name, form.provider, form.model);
        patch.provider = form.provider;
        patch.model = form.model;
      }
      if (bot.bot_managed) await api.updateBot(bot.name, patch);
      if (soulDirty) await api.updateProfileSoul(bot.name, form.soul);

      showToast(t.bots.saved, "success");
      onSaved();
      onClose();
    } catch (err) {
      showToast(apiErrorMessage(err, t.bots.saveFailed), "error");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center">
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col bg-popover shadow-xl sm:rounded-t-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={`${bot.name} — ${t.bots.details}`}
        data-testid="bot-detail"
      >
        <div className="flex items-center gap-3 border-b p-4">
          <BotAvatar name={bot.name} size="lg" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate">{form.title}</h3>
            <p className="truncate text-xs text-muted-foreground">{bot.name}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t.common.close}
            data-testid="detail-close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form
          id="bot-detail-form"
          onSubmit={handleSave}
          className="flex-1 space-y-5 overflow-y-auto p-4"
        >
          {bot.bot_managed && (
            <div className="space-y-2">
              <Label htmlFor="bot-title">{t.bots.title}</Label>
              <Input
                id="bot-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                maxLength={80}
                data-testid="bot-title"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="bot-role">{t.bots.role}</Label>
            <textarea
              id="bot-role"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={t.bots.rolePlaceholder}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              data-testid="bot-role"
            />
          </div>

          <div className="space-y-2">
            <Label>{t.bots.model}</Label>
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="current-model"
              >
                {form.model ? `${form.provider}/${form.model}` : t.bots.noModel}
              </span>
              <Button
                type="button"
                outlined
                size="sm"
                onClick={() => setPickerOpen(true)}
                data-testid="pick-model"
              >
                {t.bots.changeModel}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="bot-soul">SOUL.md</Label>
              {soulLoading && <Spinner aria-label={t.common.loading} />}
            </div>
            <textarea
              id="bot-soul"
              value={form.soul}
              onChange={(e) => {
                setSoulDirty(true);
                setForm((f) => ({ ...f, soul: e.target.value }));
              }}
              placeholder="# SOUL.md"
              rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              data-testid="bot-soul"
            />
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowSkills((v) => !v)}
              className="flex w-full items-center justify-between text-sm font-medium"
              aria-expanded={showSkills}
              data-testid="toggle-skills"
            >
              <span>{t.bots.skills}</span>
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", showSkills && "rotate-180")}
              />
            </button>
            {showSkills && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">{t.bots.skillsHint}</p>
                {skills === null ? (
                  <Spinner aria-label={t.common.loading} />
                ) : skills.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t.bots.noSkills}</p>
                ) : (
                  <ul className="space-y-1" data-testid="skill-list">
                    {skills.map((skill) => (
                      <li key={skill.name} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm">{skill.name}</span>
                        <Button
                          type="button"
                          outlined
                          size="sm"
                          aria-pressed={skill.enabled}
                          aria-label={`${skill.name}: ${skill.enabled ? t.common.enabled : t.common.disabled}`}
                          onClick={() => void toggleSkill(skill, !skill.enabled)}
                          data-testid={`skill-${skill.name}`}
                        >
                          {skill.enabled ? t.common.enabled : t.common.disabled}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{t.bots.mcpServers}</span>
              <Button
                type="button"
                outlined
                size="sm"
                onClick={() => navigate("/mcp")}
                prefix={<ExternalLink className="h-3.5 w-3.5" />}
                data-testid="open-mcp"
              >
                {t.bots.manageMcp}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t.bots.mcpHint}</p>
            {mcpServers !== null && mcpServers.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="mcp-count">
                {mcpServers.filter((s) => s.enabled).length}/{mcpServers.length}
              </p>
            )}
          </div>

          <RoutinesSection profileName={bot.name} />
        </form>

        <div className="flex gap-2 border-t p-4">
          <Button type="button" outlined className="flex-1" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            type="submit"
            form="bot-detail-form"
            className="flex-1"
            disabled={saving}
            data-testid="detail-save"
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t.bots.saveBot}
          </Button>
        </div>

        <Toast toast={toast} />

        {pickerOpen && (
          <ModelPickerDialog
            title={t.bots.model}
            alwaysGlobal
            loader={(opts) => api.getModelOptions({ profile: bot.name, refresh: opts?.refresh })}
            onApply={({ provider, model }) => {
              setForm((f) => ({ ...f, provider, model }));
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Main page                                                           */
/* ------------------------------------------------------------------ */

export function BotsPage() {
  const { t } = useI18n();
  const { setEnd } = usePageHeader();
  const navigate = useNavigate();
  const { toast, showToast } = useToast();
  const [rows, setRows] = useState<BotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailName, setDetailName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { bots } = await api.listBots();
      const enriched: BotRow[] = await Promise.all(
        bots.map(async (bot) => {
          try {
            const { sessions } = await api.getSessions(1, 0, bot.name, "recent");
            const latest = sessions[0];
            return {
              ...bot,
              preview: latest?.preview ?? null,
              last_active:
                latest && typeof latest.last_active === "number" ? latest.last_active : null,
            };
          } catch {
            // A profile without a session store is still a roster entry.
            return { ...bot, preview: null, last_active: null };
          }
        }),
      );
      // Order by recent activity (criterion 1).
      enriched.sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
      setRows(enriched);
    } catch (err) {
      showToast(apiErrorMessage(err, t.bots.loadFailed), "error");
    } finally {
      setLoading(false);
    }
  }, [showToast, t.bots.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const headerEnd = useMemo(
    () => (
      <div className="flex items-center gap-2">
        <Button
          outlined
          size="sm"
          onClick={() => void load()}
          aria-label={t.common.refresh}
          title={t.common.refresh}
          data-testid="refresh"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          data-testid="new-bot"
          prefix={<Plus className="h-4 w-4" />}
        >
          {t.bots.createBot}
        </Button>
      </div>
    ),
    [load, loading, t.bots.createBot, t.common.refresh],
  );

  useEffect(() => {
    setEnd(headerEnd);
    return () => setEnd(null);
  }, [headerEnd, setEnd]);

  /** Hand the bot's canonical Bot Chat session to the embedded TUI (criterion 2). */
  const openChat = (bot: BotRow) => {
    const sessionId = bot.bot_chat_session_id;
    if (!sessionId) {
      showToast(t.bots.chatUnavailable, "error");
      return;
    }
    navigate(
      `/chat?resume=${encodeURIComponent(sessionId)}&profile=${encodeURIComponent(bot.name)}`,
    );
  };

  const createBot = async (name: string, description: string) => {
    await api.createBot({ name, title: name, description });
    showToast(t.bots.created, "success");
    await load();
  };

  const visible = rows.filter((row) => {
    if (!query.trim()) return true;
    const needle = query.trim().toLowerCase();
    return (
      row.name.toLowerCase().includes(needle) ||
      (row.title || "").toLowerCase().includes(needle) ||
      (row.description || "").toLowerCase().includes(needle)
    );
  });

  // Only the machine's `default` profile → empty state with the create action.
  const onlyDefault = rows.length === 1 && rows[0].name === "default";
  const detailBot = rows.find((row) => row.name === detailName) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <H2>{t.bots.pageTitle}</H2>
      <Toast toast={toast} />

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Spinner aria-label={t.common.loading} />
          {t.common.loading}
        </div>
      ) : onlyDefault ? (
        <EmptyRoster onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.bots.searchPlaceholder}
              className="pl-9"
              aria-label={t.bots.searchPlaceholder}
              data-testid="bot-search"
            />
          </div>

          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground" data-testid="no-results">
              {t.bots.noResults}
            </p>
          ) : (
            <Card>
              <CardContent className="divide-y p-0">
                {visible.map((bot) => (
                  <RosterRow
                    key={bot.name}
                    bot={bot}
                    onOpenChat={openChat}
                    onOpenDetail={(b) => setDetailName(b.name)}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <CreateBotDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreate={createBot} />

      {detailBot && (
        <BotDetailSheet
          bot={detailBot}
          onClose={() => setDetailName(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}

export default BotsPage;
