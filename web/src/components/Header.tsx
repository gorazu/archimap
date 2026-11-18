import { AlertDialog, Progress, Select, Toggle, ToggleGroup } from "radix-ui";
import { Trans, useTranslation } from "react-i18next";
import { currentLanguage, LANGUAGES, type Language } from "../i18n";
import type { ZoneSummary } from "../data/zones";
import type { LiveStatus } from "../live/session";

interface Props {
  zones: ZoneSummary[];
  current: string | null;
  onSelectZone: (slug: string) => void;
  checkedCount: number;
  total: number;
  /** Starting over clears the whole zone, even when showing one part of it. */
  newHunt: { zoneName: string; count: number; onConfirm: () => void };
  /** Live capture button, when the browser supports screen capture. */
  live?: { status: LiveStatus; open: boolean; onToggle: () => void };
}

export function Header({ zones, current, onSelectZone, checkedCount, total, newHunt, live }: Props) {
  const { t } = useTranslation();
  const done = total > 0 && checkedCount === total;
  return (
    <header className="header">
      <h1 className="brand">Archimap</h1>

      <LanguagePicker />

      {zones.length > 1 ? (
        <ZoneSelect zones={zones} current={current} onSelect={onSelectZone} />
      ) : zones.length === 1 ? (
        <span className="zone-name">{zones[0].name}</span>
      ) : null}

      {total > 0 && (
        <div className={`progress${done ? " done" : ""}`} role="status">
          <span className="progress-text">
            {done ? t("header.zoneDone") : ""}
            <Trans i18nKey="header.checked" values={{ count: checkedCount, total }} components={[<strong />]} />
          </span>
          <Progress.Root className="progress-bar" value={checkedCount} max={total} aria-label={t("header.checkedLabel")}>
            <Progress.Indicator className="progress-fill" style={{ width: `${(checkedCount / total) * 100}%` }} />
          </Progress.Root>
        </div>
      )}

      {live && total > 0 && (
        <Toggle.Root className="button live-toggle" pressed={live.open} onPressedChange={live.onToggle}>
          <span className={`live-dot ${live.status}`} aria-hidden="true" />
          {t("header.live")}
        </Toggle.Root>
      )}

      {total > 0 && <NewHunt {...newHunt} />}
    </header>
  );
}

/** French and English flags; the language picked is remembered (see i18n). */
function LanguagePicker() {
  const { t, i18n } = useTranslation();
  return (
    <ToggleGroup.Root
      type="single"
      className="language-picker"
      aria-label={t("language.label")}
      value={currentLanguage()}
      onValueChange={(lng) => lng && void i18n.changeLanguage(lng)}
    >
      {LANGUAGES.map((lng) => (
        <ToggleGroup.Item key={lng} value={lng} className="flag" aria-label={t(`language.${lng}`)} title={t(`language.${lng}`)}>
          <Flag language={lng} />
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

function Flag({ language }: { language: Language }) {
  if (language === "fr") {
    return (
      <svg viewBox="0 0 3 2" aria-hidden="true">
        <rect width="1" height="2" fill="#002654" />
        <rect x="1" width="1" height="2" fill="#fff" />
        <rect x="2" width="1" height="2" fill="#ce1126" />
      </svg>
    );
  }
  // Union Jack.
  return (
    <svg viewBox="0 0 60 40" aria-hidden="true" preserveAspectRatio="none">
      <clipPath id="flag-uk-quarters">
        <path d="M30,20 h30 v20 z v20 h-30 z h-30 v-20 z v-20 h30 z" />
      </clipPath>
      <rect width="60" height="40" fill="#012169" />
      <path d="M0,0 L60,40 M60,0 L0,40" stroke="#fff" strokeWidth="8" />
      <path d="M0,0 L60,40 M60,0 L0,40" stroke="#c8102e" strokeWidth="4" clipPath="url(#flag-uk-quarters)" />
      <path d="M30,0 v40 M0,20 h60" stroke="#fff" strokeWidth="12" />
      <path d="M30,0 v40 M0,20 h60" stroke="#c8102e" strokeWidth="7" />
    </svg>
  );
}

function ZoneSelect({ zones, current, onSelect }: {
  zones: ZoneSummary[]; current: string | null; onSelect: (slug: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select.Root value={current ?? undefined} onValueChange={onSelect}>
      <Select.Trigger className="button zone-select" aria-label={t("header.zone")}>
        <Select.Value placeholder={t("header.chooseZone")} />
        <Select.Icon className="select-icon">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={4}>
          <Select.Viewport>
            {zones.map((z) => (
              <Select.Group key={z.zone}>
                <SelectItem value={z.zone}>{z.name}</SelectItem>
                {/* A zone made of several sub-areas: each one alone, below it. */}
                {(z.parts ?? []).map((p) => (
                  <SelectItem key={p.part} value={`${z.zone}/${p.part}`} part>
                    {p.name}
                  </SelectItem>
                ))}
              </Select.Group>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function SelectItem({ value, part, children }: { value: string; part?: boolean; children: string }) {
  return (
    <Select.Item value={value} className={`select-item${part ? " part" : ""}`}>
      <Select.ItemText>{children}</Select.ItemText>
      <Select.ItemIndicator className="select-check">✓</Select.ItemIndicator>
    </Select.Item>
  );
}

function NewHunt({ zoneName, count, onConfirm }: Props["newHunt"]) {
  const { t } = useTranslation();
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger className="button new-hunt" disabled={count === 0}>
        {t("header.newHunt")}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="dialog">
          <AlertDialog.Title className="dialog-title">{t("header.newHunt")}</AlertDialog.Title>
          <AlertDialog.Description className="dialog-text">
            {t("header.newHuntConfirm", { count, zone: zoneName })}
          </AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Cancel className="button">{t("header.cancel")}</AlertDialog.Cancel>
            <AlertDialog.Action className="button primary" onClick={onConfirm}>
              {t("header.uncheckAll")}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
