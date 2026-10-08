import {
  ArrowDown, ArrowUp, Ban, BookOpen, Check, ChevronDown, ChevronRight, ChevronUp, Columns2, Copy, Download, Eye, File,
  History, Image, Info, Link, List, Menu, Merge, Moon, PanelLeft, PanelRight, Pause, PencilLine, Play, Plug, Plus, Power,
  RefreshCw, Search, Sparkles, Square, Sun, Trash2, TriangleAlert, Upload, X, type LucideIcon,
} from 'lucide-react';
import markLight from '../design-system/logo/ptsb-mark-light.svg';
import markDark from '../design-system/logo/ptsb-mark-dark.svg';
import markSmallLight from '../design-system/logo/ptsb-mark-small-light.svg';
import markSmallDark from '../design-system/logo/ptsb-mark-small-dark.svg';

// Lucide, the reader's icon set. One icon per concept.
const ICONS = {
  x: X,
  sun: Sun,
  moon: Moon,
  plug: Plug,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  plus: Plus,
  upload: Upload,
  download: Download,
  link: Link,
  trash: Trash2,
  edit: PencilLine,
  history: History,
  sparkle: Sparkles,
  check: Check,
  alert: TriangleAlert,
  info: Info,
  play: Play,
  pause: Pause,
  stop: Square,
  refresh: RefreshCw,
  file: File,
  book: BookOpen,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  copy: Copy,
  eye: Eye,
  list: List,
  menu: Menu,
  power: Power,
  merge: Merge,
  ban: Ban,
  search: Search,
  split: Columns2,
  image: Image,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
    />
  );
}

/** The Smartbook mark, theme aware; below 32px the two-page small mark is used. */
export function Logo({ size = 28 }: { size?: number }) {
  const small = size < 32;
  return (
    <span className="ui-logo" style={{ width: size, height: size }}>
      <img className="ui-logo__light" src={small ? markSmallLight : markLight} width={size} height={size} alt="" />
      <img className="ui-logo__dark" src={small ? markSmallDark : markDark} width={size} height={size} alt="" />
    </span>
  );
}
