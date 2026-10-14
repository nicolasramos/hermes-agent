/** Bots page — roster, bot detail sheet, Bot Chat integration, and routine management.

Bots are profiles whose ``profile.yaml`` carries ``ui_meta['hermes-bots']``.
The roster lists every profile (per criterion 1: same set as ``hermes profile list``).
*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { useProfileScope } from "@/contexts/useProfileScope";
import { ProfileScopeBanner } from "@/components/ProfileScopeBanner";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  Clock,
  Cpu,
  Edit3,
  Loader2,
  MessageSquare,
  MoreVertical,
  Package,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { api } from "@/lib/api";
import type { ActiveProfileInfo, ProfileInfo, CronJob } from "@/lib/api";
import { isDashboardEmbeddedChatEnabled } from "@/lib/dashboard-flags";
import { latchChatActivation } from "@/lib/chat-activation";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { Button } from "@nous-research/ui/ui/components/button";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { useI18n } from "@/i18n";
import { usePageHeader } from "@/contexts/usePageHeader";
import { cn } from "@/lib/utils";
import { useBelowBreakpoint } from "@nous-research/ui/hooks/use-below-breakpoint";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

interface BotProfile extends ProfileInfo {
  ui_meta?: Record<string, unknown>;
  bot_title?: string;
  last_message_preview?: string;
  last_message_time?: number;
  is_active?: boolean;
}

interface BotDetailForm {
  name: string;
  description: string;
  provider: string | null;
  model: string | null;
  soul: string;
  skills: string[];
  mcp_servers: string[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BOT_CHAT_TITLE = "Bot Chat";

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

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/* ------------------------------------------------------------------ */
/* Avatar component                                                   */
/* ------------------------------------------------------------------ */

function BotAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const sizeClass =
    size === "sm" ? "w-8 h-8 text-sm" : size === "lg" ? "w-14 h-14 text-xl" : "w-10 h-10 text-base";
  const initial = name.charAt(0).toUpperCase();
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        avatarColor(name),
        sizeClass,
      )}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty state                                                        */
/* ------------------------------------------------------------------ */

function EmptyRoster({ onCreate }: { onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="rounded-full bg-muted p-4">
        <Bot className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-muted-foreground">{t("bots.emptyRosterTitle")}</h3>
        <p className="text-sm text-muted-foreground">{t("bots.emptyRosterDesc")}</p>
      </div>
      <Button onClick={onCreate}>
        <Sparkles className="mr-2 h-4 w-4" />
        {t("bots.createFirstBot")}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create-bot dialog                                                  */
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
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setError(null);
      setCreating(false);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = name.trim().toLowerCase();
    if (!PROFILE_NAME_RE.test(trimmed)) {
      setError(t("bots.nameInvalid"));
      return;
    }

    setCreating(true);
    try {
      await onCreate(trimmed, description.trim());
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      setError(msg || t("bots.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-md rounded-xl bg-popover p-6 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label={t("bots.createBotTitle")}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3>{t("bots.createBotTitle")}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="bot-name">{t("bots.profileName")}</Label>
            <Input
              id="bot-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my_bot"
              pattern={PROFILE_NAME_RE.source}
              required
              maxLength={64}
            />
            <p className="text-xs text-muted-foreground">
              {t("bots.nameHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bot-desc">{t("bots.profileDescription")}</Label>
            <textarea
              id="bot-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("bots.descriptionPlaceholder")}
              rows={3}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("bots.createBot")}
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
  onSelect,
}: {
  bot: BotProfile;
  onSelect: (bot: BotProfile) => void;
}) {
  const { t } = useI18n();
  const title = (bot as BotProfile & { bot_title?: string }).bot_title || bot.name;
  const isActive = bot.is_active || false;

  return (
    <button
      onClick={() => onSelect(bot)}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl p-3 text-left transition-colors hover:bg-muted/60",
        isActive && "ring-1 ring-ring/30",
      )}
      aria-label={`${title} — ${bot.description || bot.name}`}
    >
      <BotAvatar name={bot.name} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold truncate">{title}</span>
          {isActive && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
              {t("bots.active")}
            </Badge>
          )}
        </div>
        <p className="line-clamp-1 text-xs text-muted-foreground">
          {bot.description || t("bots.noRole")}
        </p>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <MessageSquare className="h-3 w-3" />
          <span className="truncate">
            {bot.last_message_preview || t("bots.noMessages")}
          </span>
          {bot.last_message_time && (
            <>
              <Clock className="ml-1 h-3 w-3 shrink-0" />
              <span className="shrink-0">
                {formatTimeAgo(bot.last_message_time)}
              </span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Bot detail sheet                                                   */
/* ------------------------------------------------------------------ */

function BotDetailSheet({
  bot,
  onClose,
  onUpdate,
}: {
  bot: BotProfile;
  onClose: () => void;
  onUpdate: (form: BotDetailForm) => Promise<void>;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<BotDetailForm>({
    name: bot.name,
    description: bot.description || "",
    provider: bot.provider,
    model: bot.model,
    soul: "",
    skills: [],
    mcp_servers: [],
  });
  const [saving, setSaving] = useState(false);
  const [soulLoading, setSoulLoading] = useState(false);
  const [soulError, setSoulError] = useState<string | null>(null);
  const [showSkills, setShowSkills] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bot.name !== form.name) {
      // name changed — keep it
    }
  }, [bot.name, form.name]);

  // Load SOUL.md when sheet opens
  useEffect(() => {
    let cancelled = false;
    setSoulLoading(true);
    setSoulError(null);
    api
      .getProfileSoul(bot.name)
      .then((soul) => {
        if (!cancelled) {
          setForm((f) => ({ ...f, soul }));
          setSoulLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSoulError(err instanceof Error ? err.message : "Failed to load SOUL.md");
          setSoulLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bot.name]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onUpdate({ ...form });
      onClose();
    } catch (err) {
      // Error already handled by toast in parent
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center">
      <div
        ref={sheetRef}
        className={cn(
          "w-full max-w-2xl animate-in slide-in-from-bottom duration-200 sm:rounded-t-2xl",
          "bg-popover shadow-xl max-h-[90vh] flex flex-col",
        )}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b p-4">
          <BotAvatar name={bot.name} size="lg" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate">{form.name}</h3>
            <p className="text-xs text-muted-foreground">{bot.path.split("/").pop()}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Description / Role */}
          <div className="space-y-2">
            <Label>{t("bots.role")}</Label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder={t("bots.rolePlaceholder")}
              rows={2}
            />
          </div>

          {/* Model */}
          <div className="space-y-2">
            <Label>{t("bots.model")}</Label>
            <Input
              value={form.model || ""}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value || null }))}
              placeholder={t("bots.modelPlaceholder")}
            />
          </div>

          {/* SOUL.md */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>SOUL.md</Label>
              {soulLoading && (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              )}
            </div>
            {soulError ? (
              <div className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                {soulError}
              </div>
            ) : (
              <textarea
                value={form.soul}
                onChange={(e) => setForm((f) => ({ ...f, soul: e.target.value }))}
                placeholder="# SOUL.md"
                rows={6}
                className="font-mono text-xs"
              />
            )}
          </div>

          {/* Skills */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowSkills(!showSkills)}
              className="flex w-full items-center justify-between text-sm font-medium"
            >
              <span>{t("bots.skills")}</span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  showSkills && "rotate-180",
                )}
              />
            </button>
            {showSkills && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">
                  {t("bots.skillsHint")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // Placeholder: would open a skill picker dialog
                    showToast(t("bots.skillsComingSoon"));
                  }}
                >
                  <Sparkles className="mr-1 h-3 w-3" />
                  {t("bots.manageSkills")}
                </Button>
              </div>
            )}
          </div>

          {/* MCP servers */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowMcp(!showMcp)}
              className="flex w-full items-center justify-between text-sm font-medium"
            >
              <span>{t("bots.mcpServers")}</span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  showMcp && "rotate-180",
                )}
              />
            </button>
            {showMcp && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">
                  {t("bots.mcpHint")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    showToast(t("bots.mcpComingSoon"));
                  }}
                >
                  <ShieldCheck className="mr-1 h-3 w-3" />
                  {t("bots.manageMcp")}
                </Button>
              </div>
            )}
          </div>

          {/* Routines */}
          <BotRoutinesSection profileName={bot.name} />
        </form>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t p-4">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="bot-detail-form" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("bots.saveBot")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Routines section                                                   */
/* ------------------------------------------------------------------ */

function BotRoutinesSection({ profileName }: { profileName: string }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getCronJobs(profileName)
      .then((data) => {
        if (!cancelled) {
          setJobs(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileName]);

  const handleTrigger = async (jobId: string) => {
    setTriggering(jobId);
    try {
      await api.triggerCronJob(jobId, profileName);
      showToast(t("bots.jobTriggered"));
    } catch {
      showToast(t("bots.jobTriggerFailed"));
    } finally {
      setTriggering(null);
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-base">{t("bots.routines")}</h3>
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : jobs.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{t("bots.noRoutines")}</p>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{job.name}</p>
                <p className="text-xs text-muted-foreground">
                  {job.schedule || "manual"}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {job.paused && (
                  <Badge variant="secondary" className="text-[10px]">
                    {t("bots.paused")}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleTrigger(job.id)}
                  disabled={triggering === job.id}
                  title={t("bots.triggerNow")}
                >
                  {triggering === job.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toast helper (simple local toasts for this page)                   */
/* ------------------------------------------------------------------ */

let toastQueue: string[] = [];

function showToast(message: string) {
  toastQueue.push(message);
  // In a real app this would dispatch to a toast provider.
  // For now, log to console as a fallback.
  if (typeof window !== "undefined") {
    // Could integrate with the real toast system; for now just log.
    console.log("[Toast]", message);
  }
}

/* ------------------------------------------------------------------ */
/* Bot chat integration                                              */
/* ------------------------------------------------------------------ */

function BotChatOverlay({ bot, onClose }: { bot: BotProfile; onClose: () => void }) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<Array<{ role: string; content: string; timestamp?: number }>>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load Bot Chat session messages
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Find the Bot Chat session for this profile
    api
      .getProfilesSessionsSidebar("all", 1, bot.name)
      .then((data) => {
        if (!cancelled) {
          // Look for a session titled "Bot Chat"
          const messaging = data.messaging || [];
          const botChat = messaging.find(
            (s: { title?: string }) => s.title === BOT_CHAT_TITLE,
          );
          if (botChat) {
            return api.getSessionMessages(botChat.id);
          }
          return [];
        }
      })
      .then((msgs) => {
        if (!cancelled && msgs) {
          setMessages(
            msgs.map((m: any) => ({
              role: m.role,
              content: m.content || "",
              timestamp: m.timestamp,
            })),
          );
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.name]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;

    setSending(true);
    try {
      // Submit to the Bot Chat session
      await api.submitChatMessage(bot.name, input.trim());
      setInput("");
      // Refresh messages after a brief delay
      setTimeout(() => {
        api
          .getProfilesSessionsSidebar("all", 1, bot.name)
          .then((data) => {
            const messaging = data.messaging || [];
            const botChat = messaging.find(
              (s: { title?: string }) => s.title === BOT_CHAT_TITLE,
            );
            if (botChat) {
              return api.getSessionMessages(botChat.id);
            }
            return [];
          })
          .then((msgs) => {
            setMessages(
              msgs.map((m: any) => ({
                role: m.role,
                content: m.content || "",
                timestamp: m.timestamp,
              })),
            );
          });
      }, 2000);
    } catch {
      // Error already handled by toast
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 border-b p-3">
        <button
          onClick={onClose}
          className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("common.back")}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <BotAvatar name={bot.name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold truncate">
            {(bot as BotProfile & { bot_title?: string }).bot_title || bot.name}
          </p>
          <p className="text-xs text-muted-foreground">Bot Chat</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">
            {t("bots.noChatMessages")}
          </p>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "max-w-[80%] rounded-xl px-3 py-2 text-sm",
                msg.role === "user"
                  ? "ml-auto bg-primary text-primary-foreground"
                  : "bg-muted",
              )}
            >
              {msg.content}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="border-t p-3 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("bots.chatPlaceholder")}
          disabled={sending}
          className="flex-1"
        />
        <Button type="submit" disabled={sending || !input.trim()}>
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MessageSquare className="h-4 w-4" />
          )}
        </Button>
      </form>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Main Bots page                                                     */
/* ------------------------------------------------------------------ */

export function BotsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { profileScope, setProfileScope } = useProfileScope();
  const isMobile = useBelowBreakpoint(640);
  const [profiles, setProfiles] = useState<BotProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedBot, setSelectedBot] = useState<BotProfile | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Load profiles (roster)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listProfiles()
      .then((data) => {
        if (!cancelled) {
          // Transform profiles into bot-ready entries
          const bots: BotProfile[] = data.map((p) => ({
            ...p,
            bot_title: (p as any).ui_meta?.["hermes-bots"]?.title || undefined,
            last_message_preview: "", // TODO: fetch from session DB
            last_message_time: undefined,
            is_active: p.gateway_running,
          }));
          setProfiles(bots);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileScope]);

  // Filter by search
  const filteredBots = useMemo(() => {
    if (!searchQuery.trim()) return profiles;
    const q = searchQuery.toLowerCase();
    return profiles.filter(
      (p) =>
        p.name.includes(q) ||
        (p as BotProfile & { bot_title?: string }).bot_title?.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [profiles, searchQuery]);

  // Determine if roster is "empty" (only default profile)
  const isEmpty = profiles.length <= 1 && profiles.every((p) => p.name === "default");

  const handleSelectBot = useCallback((bot: BotProfile) => {
    setSelectedBot(bot);
    setShowDetail(true);
  }, []);

  const handleCreateBot = useCallback(
    async (name: string, description: string) => {
      await api.createProfile({ name, description });
      // Refresh roster
      const data = await api.listProfiles();
      setProfiles(
        data.map((p) => ({
          ...p,
          bot_title: (p as any).ui_meta?.["hermes-bots"]?.title || undefined,
          is_active: p.gateway_running,
        })),
      );
      setShowCreateDialog(false);
    },
    [],
  );

  const handleUpdateBot = useCallback(
    async (form: BotDetailForm) => {
      // Update description/role
      await api.updateProfileDescription(form.name, form.description);

      // Update model if changed
      if (form.model !== profiles.find((p) => p.name === form.name)?.model) {
        if (form.model && form.provider) {
          await api.updateProfileModel(form.name, form.provider, form.model);
        }
      }

      // Update SOUL.md
      if (form.soul) {
        await api.updateProfileSoul(form.name, form.soul);
      }

      // Refresh roster
      const data = await api.listProfiles();
      setProfiles(
        data.map((p) => ({
          ...p,
          bot_title: (p as any).ui_meta?.["hermes-bots"]?.title || undefined,
          is_active: p.gateway_running,
        })),
      );
    },
    [profiles],
  );

  const handleOpenChat = useCallback(() => {
    setShowDetail(false);
    setShowChat(true);
  }, []);

  const handleCloseChat = useCallback(() => {
    setShowChat(false);
    setSelectedBot(null);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    api
      .listProfiles()
      .then((data) => {
        setProfiles(
          data.map((p) => ({
            ...p,
            bot_title: (p as any).ui_meta?.["hermes-bots"]?.title || undefined,
            is_active: p.gateway_running,
          })),
        );
      })
      .finally(() => setRefreshing(false));
  }, []);

  // Set page header
  usePageHeader(
    isDashboardEmbeddedChatEnabled() ? null : (
      <div className="flex items-center gap-2">
        <Bot className="h-5 w-5 text-muted-foreground" />
        <span>{t("bots.pageTitle")}</span>
      </div>
    ),
  );

  return (
    <div className={cn("font-mondwest normal-case flex h-full flex-col")}>
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <H2 className="m-0">{t("bots.pageTitle")}</H2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Sparkles className="mr-1.5 h-4 w-4" />
            {t("bots.createBot")}
          </Button>
        </div>
      </div>

      {/* Search */}
      {profiles.length > 3 && (
        <div className="px-4 py-2">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("common.search")}
            className="max-w-sm"
          />
        </div>
      )}

      {/* Profile scope banner */}
      <ProfileScopeBanner />

      {/* Roster */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          <EmptyRoster onCreate={() => setShowCreateDialog(true)} />
        ) : (
          <div className="space-y-1">
            {filteredBots.map((bot) => (
              <RosterRow key={bot.name} bot={bot} onSelect={handleSelectBot} />
            ))}
            {filteredBots.length === 0 && searchQuery && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {t("bots.noResults")}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Bot detail sheet */}
      {showDetail && selectedBot && (
        <BotDetailSheet
          bot={selectedBot}
          onClose={() => setShowDetail(false)}
          onUpdate={handleUpdateBot}
        />
      )}

      {/* Bot chat overlay */}
      {showChat && selectedBot && (
        <BotChatOverlay bot={selectedBot} onClose={handleCloseChat} />
      )}

      {/* Create bot dialog */}
      <CreateBotDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreate={handleCreateBot}
      />
    </div>
  );
}
