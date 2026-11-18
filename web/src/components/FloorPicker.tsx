import type { TFunction } from "i18next";
import { Select } from "radix-ui";
import { useTranslation } from "react-i18next";
import type { ZoneFloor } from "../data/zones";

/** A landing's name, or its number (in climbing order). */
export function floorLabel(t: TFunction, floors: ZoneFloor[], n: number): string {
  return floors[n]?.name ?? t("floor.number", { n: n + 1 });
}

export interface FloorChoice {
  floors: ZoneFloor[];
  current: number;
  /** Maps checked on each landing. */
  checked: number[];
  onChange: (floor: number) => void;
}

/** Like a lift: up, down, or straight to a landing from the list. */
export function FloorPicker({ floors, current, checked, onChange }: FloorChoice) {
  const { t } = useTranslation();
  const count = (n: number) =>
    floors[n].check === false ? t("floor.nothing") : `${checked[n]} / ${floors[n].maps}`;
  return (
    <div className="floor-picker" role="group" aria-label={t("floor.label")}>
      <button
        type="button"
        className="button floor-step"
        disabled={current >= floors.length - 1}
        onClick={() => onChange(current + 1)}
        aria-label={t("floor.up")}
        title={t("floor.up")}
      >
        ▲
      </button>
      <Select.Root value={String(current)} onValueChange={(v) => onChange(Number(v))}>
        <Select.Trigger className="button floor-select" aria-label={t("floor.label")}>
          <Select.Value>
            <span className="floor-name">{floorLabel(t, floors, current)}</span>
            <small>{count(current)}</small>
          </Select.Value>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="select-content" position="popper" side="top" sideOffset={4}>
            <Select.Viewport>
              {/* Top landing first, as in a building. */}
              {floors.map((_, n) => floors.length - 1 - n).map((n) => (
                <Select.Item key={n} value={String(n)} className="select-item floor-item">
                  <Select.ItemText>{floorLabel(t, floors, n)}</Select.ItemText>
                  <small className={floors[n].check !== false && checked[n] === floors[n].maps ? "floor-done" : ""}>
                    {count(n)}
                  </small>
                  <Select.ItemIndicator className="select-check">✓</Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      <button
        type="button"
        className="button floor-step"
        disabled={current <= 0}
        onClick={() => onChange(current - 1)}
        aria-label={t("floor.down")}
        title={t("floor.down")}
      >
        ▼
      </button>
    </div>
  );
}
