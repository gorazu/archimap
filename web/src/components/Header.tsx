import type { ZoneSummary } from "../data/zones";
import type { LiveStatus } from "../live/session";

interface Props {
  zones: ZoneSummary[];
  current: string | null;
  onSelectZone: (slug: string) => void;
  checkedCount: number;
  total: number;
  onNewHunt: () => void;
  /** Live capture button, when the browser supports screen capture. */
  live?: { status: LiveStatus; open: boolean; onToggle: () => void };
}

export function Header({ zones, current, onSelectZone, checkedCount, total, onNewHunt, live }: Props) {
  const done = total > 0 && checkedCount === total;
  const percent = total > 0 ? (checkedCount / total) * 100 : 0;
  return (
    <header className="header">
      <h1 className="brand">Archimap</h1>

      {zones.length > 1 ? (
        <select
          className="zone-select"
          aria-label="Zone"
          value={current ?? ""}
          onChange={(e) => onSelectZone(e.target.value)}
        >
          {zones.map((z) => (
            <option key={z.zone} value={z.zone}>
              {z.name}
            </option>
          ))}
        </select>
      ) : zones.length === 1 ? (
        <span className="zone-name">{zones[0].name}</span>
      ) : null}

      {total > 0 && (
        <div className={`progress${done ? " done" : ""}`} role="status">
          <span className="progress-text">
            {done ? "Zone terminée ! " : ""}
            <strong>{checkedCount}</strong> / {total} vérifiées
          </span>
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {live && total > 0 && (
        <button
          type="button"
          className={`live-toggle${live.open ? " open" : ""}`}
          onClick={live.onToggle}
          aria-pressed={live.open}
        >
          <span className={`live-dot ${live.status}`} aria-hidden="true" />
          Direct
        </button>
      )}

      {total > 0 && (
        <button type="button" className="new-hunt" onClick={onNewHunt} disabled={checkedCount === 0}>
          Nouvelle chasse
        </button>
      )}
    </header>
  );
}
