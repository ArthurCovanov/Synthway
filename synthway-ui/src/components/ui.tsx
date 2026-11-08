import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './ui.module.css';

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export { cx };

/* ---------- Panels ---------- */

export function Panel({
  className,
  children,
  as: Tag = 'section',
}: {
  className?: string;
  children: ReactNode;
  as?: 'section' | 'div' | 'aside';
}) {
  return <Tag className={cx(styles.panel, className)}>{children}</Tag>;
}

export function Section({
  title,
  badge,
  actions,
  children,
  className,
}: {
  title: string;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.section, className)}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {badge}
        {actions && <div className={styles.sectionActions}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/* ---------- Buttons ---------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary';
  size?: 'normal' | 'small';
  iconOnly?: boolean;
};

export function Button({
  variant = 'default',
  size = 'normal',
  iconOnly = false,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        styles.btn,
        variant === 'primary' && styles.primary,
        size === 'small' && styles.small,
        iconOnly && styles.iconOnly,
        className,
      )}
      {...props}
    />
  );
}

/* ---------- Badges ---------- */

const BADGE_TONE = {
  live: styles.badgeLive,
  soon: styles.badgeSoon,
  neutral: styles.badgeNeutral,
  danger: styles.badgeDanger,
};

export function Badge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: keyof typeof BADGE_TONE;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx(styles.badge, BADGE_TONE[tone])} title={title}>
      {children}
    </span>
  );
}

/** Badge for settings that are saved but not yet sent to synthway-core */
export function SoonBadge() {
  return (
    <Badge tone="soon" title="Réglage enregistré, mais pas encore pris en charge par synthway-core">
      Bientôt
    </Badge>
  );
}

/** Badge for settings that drive the engine live */
export function LiveBadge() {
  return (
    <Badge tone="live" title="Envoyé au moteur audio en temps réel">
      Moteur
    </Badge>
  );
}

/* ---------- Slider ---------- */

/** A slider value typed by hand, in its own unit (not the slider's position) */
export interface ValueEdit {
  value: number;
  min: number;
  max: number;
  /** Shown before the field, e.g. × */
  prefix?: string;
  /** Shown after the field, e.g. %, ms */
  unit?: string;
  /** Decimals shown when the popup opens */
  decimals?: number;
  onCommit: (value: number) => void;
  /** More controls under the field, applied at once */
  extra?: ReactNode;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
  edit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Makes the value clickable, to type it in a popup */
  edit?: ValueEdit;
}) {
  const id = useId();
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className={styles.slider}>
      <span className={styles.sliderHead}>
        <label htmlFor={id}>{label}</label>
        {edit ? (
          <ValueButton label={label} display={format(value)} edit={edit} disabled={disabled} />
        ) : (
          <span className={styles.sliderValue}>{format(value)}</span>
        )}
      </span>
      <input
        id={id}
        type="range"
        className={styles.range}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ '--fill': `${fill}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

/** One bound of a RangeSlider: its handle's position (0 to 1) and how it is shown */
export interface RangeBound {
  label: string;
  position: number;
  display: string;
  onChange: (position: number) => void;
  edit?: ValueEdit;
}

/**
 * Two handles on one bar, for a range such as a filter's band. The parent
 * keeps the lower bound under the upper one.
 */
export function RangeSlider({
  label,
  low,
  high,
  step,
  disabled,
}: {
  label: string;
  low: RangeBound;
  high: RangeBound;
  step: number;
  disabled?: boolean;
}) {
  // Two handles on the same spot: the one with room to move goes on top
  const lowOnTop = low.position > 0.5;
  const value = (bound: RangeBound) =>
    bound.edit ? (
      <ValueButton label={bound.label} display={bound.display} edit={bound.edit} disabled={disabled} />
    ) : (
      <span className={styles.sliderValue}>{bound.display}</span>
    );
  const handle = (bound: RangeBound, onTop: boolean) => (
    <input
      type="range"
      className={cx(styles.range, onTop && styles.rangeOnTop)}
      aria-label={bound.label}
      aria-valuetext={bound.display}
      min={0}
      max={1}
      step={step}
      value={bound.position}
      disabled={disabled}
      onChange={(event) => bound.onChange(Number(event.target.value))}
    />
  );
  return (
    <div className={styles.slider}>
      <span className={styles.sliderHead}>
        <span>{label}</span>
        <span className={styles.rangeValues}>
          {value(low)}
          <span aria-hidden>–</span>
          {value(high)}
        </span>
      </span>
      <div className={styles.dualRange} style={{ '--from': low.position, '--to': high.position } as CSSProperties}>
        <div className={styles.dualTrack} />
        {handle(low, lowOnTop)}
        {handle(high, !lowOnTop)}
      </div>
    </div>
  );
}

function ValueButton({
  label,
  display,
  edit,
  disabled,
}: {
  label: string;
  display: string;
  edit: ValueEdit;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={cx(styles.sliderValue, styles.valueButton)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label} : ${display}, saisir la valeur`}
        title="Saisir la valeur"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {display}
      </button>
      {open && <ValuePopover anchor={button} label={label} edit={edit} onClose={close} />}
    </>
  );
}

const POPOVER_GAP = 6;
const POPOVER_MARGIN = 8;

const toText = (value: number, decimals: number) => String(Number(value.toFixed(decimals)));

/** Accepts a comma as the decimal separator; null if it is not a number */
function parseNumber(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (normalized === '') return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Small window under a slider value: type a number, Enter applies, Escape or a
 * click outside cancels. Rendered in <body>, since the panels' backdrop-filter
 * would otherwise clip and position it.
 */
function ValuePopover({
  anchor,
  label,
  edit,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement>;
  label: string;
  edit: ValueEdit;
  onClose: (refocus: boolean) => void;
}) {
  const { value, min, max, prefix, unit, decimals = 2, onCommit, extra } = edit;
  const [text, setText] = useState(() => toText(value, decimals));
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const placed = position !== null;

  // The value can change while the popup is open: shortcuts in `extra`, the slider, the graphs
  useEffect(() => setText(toText(value, decimals)), [value, decimals]);

  // Under the value, or above it when there is no room below; follows it on scroll
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const box = panel.current;
      if (!rect || !box) return;
      const left = Math.max(
        POPOVER_MARGIN,
        Math.min(window.innerWidth - box.offsetWidth - POPOVER_MARGIN, rect.right - box.offsetWidth),
      );
      const below = rect.bottom + POPOVER_GAP;
      const fits = below + box.offsetHeight <= window.innerHeight - POPOVER_MARGIN;
      setPosition({ left, top: fits ? below : Math.max(POPOVER_MARGIN, rect.top - POPOVER_GAP - box.offsetHeight) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    if (!placed) return;
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, [placed]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [anchor, onClose]);

  const parsed = parseNumber(text);
  const valid = parsed !== null && parsed >= min && parsed <= max;
  const bound = (limit: number) => `${prefix ?? ''}${toText(limit, 4)}`;

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      className={styles.popover}
      style={position ?? { left: 0, top: 0, opacity: 0 }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose(true);
        }
      }}
    >
      <div className={styles.popoverTitle}>{label}</div>
      <form
        className={styles.popoverRow}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || parsed === null) return;
          onCommit(parsed);
          onClose(true);
        }}
      >
        <label className={styles.popoverField}>
          {prefix && <span className={styles.popoverAffix}>{prefix}</span>}
          <input
            ref={input}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-label={label}
            aria-invalid={!valid}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {unit && <span className={styles.popoverAffix}>{unit}</span>}
        </label>
        <Button type="submit" variant="primary" size="small" disabled={!valid}>
          OK
        </Button>
      </form>
      <div className={cx(styles.popoverRange, !valid && styles.popoverInvalid)}>
        Entre {bound(min)} et {bound(max)}
        {unit ? ` ${unit}` : ''}
      </div>
      {extra}
    </div>,
    document.body,
  );
}

/* ---------- Segmented control ---------- */

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  compact = false,
  label,
  disabled,
}: {
  options: { value: T; label: string; icon?: ReactNode; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  compact?: boolean;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className={cx(styles.segmented, compact && styles.compact)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={styles.segment}
          aria-pressed={option.value === value}
          title={option.title ?? option.label}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Form fields ---------- */

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export const inputClass = styles.input;
export const selectClass = styles.select;

/* ---------- Toggle switch ---------- */

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={styles.toggle}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.toggleText}>
        <span className={styles.toggleLabel}>{label}</span>
        {hint && <span className={styles.toggleHint}>{hint}</span>}
      </span>
      <span className={styles.switch} aria-hidden="true" />
    </button>
  );
}
