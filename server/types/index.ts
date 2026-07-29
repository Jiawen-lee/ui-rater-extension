export type InteractionEventKind =
  | 'expand' | 'collapse'
  | 'hover_start' | 'hover_end'
  | 'iframe_click' | 'iframe_scroll'
  | 'mousemove' | 'input';

export interface InteractionEvent {
  kind: InteractionEventKind;
  side: 'left' | 'right';
  ts: number;
  x?: number;
  y?: number;
  tag?: string;
  text?: string;
  viewport_w?: number;
  viewport_h?: number;
  scroll_y?: number;
  scroll_pct?: number;
  is_fixed?: true;
  href?: string;
  field?: string;
  value?: string;
}

export interface IssueMarker {
  ts_ms: number;          // offset into the task recording, in milliseconds
  note: string;           // participant's description of the usability issue (may be empty)
  created_at?: string;    // ISO timestamp of when the marker was added
}

export interface Trial {
  index: number;
  slug: string;                        // full data depot slug
  group: string;                       // short group name (e.g. "gamestop")
  task_app: string;
  task_prompt: string;
  plain_app: string;
  defect_app: string;
  defect_principle: string;
  defect_descriptions: string[];
  suggested_flows: string[];
  plain_side: 'left' | 'right';
  selected_side: 'left' | 'right' | null;
  is_correct: boolean | null;
  agrees_with_defect: boolean | null;
  completed: boolean;
  timestamp: string | null;
  view_start: string | null;
  duration_ms: number | null;
  interactions: InteractionEvent[];
  feedback: string | null;
  issue_markers?: IssueMarker[];
}

export interface AppEntry {
  name: string;
  group: string;
  staticPath: string;
  indexPath: string;
  screenshotPath: string | null;
  isDefect?: boolean;
  defectPrinciple?: string;
}

export interface TrialConfigEntry {
  slug: string;
  group: string;
  plain_app: string;
  task_prompt: string;
  site_url?: string;
  start_path?: string;
  defects: { app: string; principle: string; defect_descriptions: string[] }[];
  suggested_flows: string[];
}

export interface ParticipantData {
  trials: Trial[];
}

export type ResultsStore = Record<string, ParticipantData>;
