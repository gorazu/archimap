import { AlertDialog, Progress, Select, Toggle } from "radix-ui";
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
  const done = total > 0 && checkedCount === total;
  return (
    <header className="header">
      <h1 className="brand">Archimap</h1>

      {zones.length > 1 ? (
        <ZoneSelect zones={zones} current={current} onSelect={onSelectZone} />
      ) : zones.length === 1 ? (
        <span className="zone-name">{zones[0].name}</span>
      ) : null}

      {total > 0 && (
        <div className={`progress${done ? " done" : ""}`} role="status">
          <span className="progress-text">
            {done ? "Zone terminée ! " : ""}
            <strong>{checkedCount}</strong> / {total} vérifiées
          </span>
          <Progress.Root className="progress-bar" value={checkedCount} max={total} aria-label="Cartes vérifiées">
            <Progress.Indicator className="progress-fill" style={{ width: `${(checkedCount / total) * 100}%` }} />
          </Progress.Root>
        </div>
      )}

      {live && total > 0 && (
        <Toggle.Root className="button live-toggle" pressed={live.open} onPressedChange={live.onToggle}>
          <span className={`live-dot ${live.status}`} aria-hidden="true" />
          Direct
        </Toggle.Root>
      )}

      {total > 0 && <NewHunt {...newHunt} />}
    </header>
  );
}

function ZoneSelect({ zones, current, onSelect }: {
  zones: ZoneSummary[]; current: string | null; onSelect: (slug: string) => void;
}) {
  return (
    <Select.Root value={current ?? undefined} onValueChange={onSelect}>
      <Select.Trigger className="button zone-select" aria-label="Zone">
        <Select.Value placeholder="Choisir une zone" />
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
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger className="button new-hunt" disabled={count === 0}>
        Nouvelle chasse
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay" />
        <AlertDialog.Content className="dialog">
          <AlertDialog.Title className="dialog-title">Nouvelle chasse</AlertDialog.Title>
          <AlertDialog.Description className="dialog-text">
            Décocher {count > 1 ? `les ${count} cartes vérifiées` : "la carte vérifiée"} de « {zoneName} » ?
          </AlertDialog.Description>
          <div className="dialog-actions">
            <AlertDialog.Cancel className="button">Annuler</AlertDialog.Cancel>
            <AlertDialog.Action className="button primary" onClick={onConfirm}>
              Tout décocher
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
