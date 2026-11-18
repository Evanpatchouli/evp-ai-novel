import type {
  ContextCandidate,
  DecisionStatus,
  FinalConfirmation,
  ReviewIssue,
  WritePreview,
} from "../../../../shared/contracts";
import type { TaskDetail } from "../../api";

export const STYLE_REFINEMENT_INSTRUCTION =
  "根据写作规范，对通篇的文笔文风进行润色。";

export const DEFAULT_CONFIRMATION: FinalConfirmation = {
  fullyRead: false,
  plotAndCharacterApproved: false,
  noUnauthorizedCanon: false,
  continuityApproved: false,
  willingToFinalize: false,
};

export interface WorkflowState {
  taskId: string | null;
  context: ContextCandidate[];
  prompt: string;
  reviewText: string;
  revisionText: string;
  issues: ReviewIssue[];
  revisionInstructionAdditions: string[];
  confirmation: FinalConfirmation;
  preview: WritePreview | null;
}

export function createWorkflowState(task: TaskDetail | null): WorkflowState {
  return {
    taskId: task?.id ?? null,
    context: task?.context ?? [],
    prompt: task?.prompt ?? "",
    reviewText: task?.reviewRaw ?? "",
    revisionText: task?.revisionRaw ?? "",
    issues: task?.issues ?? [],
    revisionInstructionAdditions: task?.prompt?.includes(
      STYLE_REFINEMENT_INSTRUCTION,
    )
      ? [STYLE_REFINEMENT_INSTRUCTION]
      : [],
    confirmation: task?.finalConfirmation ?? DEFAULT_CONFIRMATION,
    preview: null,
  };
}

export type WorkflowStateAction =
  | { type: "reset"; task: TaskDetail | null }
  | { type: "patch"; patch: Partial<WorkflowState> }
  | { type: "toggle-context"; index: number; selected: boolean }
  | { type: "update-issue"; index: number; patch: Partial<ReviewIssue> }
  | { type: "confirm"; key: keyof FinalConfirmation; checked: boolean }
  | { type: "set-all-decisions"; decision: DecisionStatus }
  | {
      type: "toggle-revision-instruction";
      instruction: string;
      checked: boolean;
    }
  | { type: "confirm-all" };

export function workflowStateReducer(
  state: WorkflowState,
  action: WorkflowStateAction,
): WorkflowState {
  if (action.type === "reset") return createWorkflowState(action.task);
  if (action.type === "patch") return { ...state, ...action.patch };
  if (action.type === "toggle-context")
    return {
      ...state,
      context: state.context.map((item, index) =>
        index === action.index ? { ...item, selected: action.selected } : item,
      ),
    };
  if (action.type === "update-issue")
    return {
      ...state,
      issues: state.issues.map((item, index) =>
        index === action.index ? { ...item, ...action.patch } : item,
      ),
    };
  if (action.type === "set-all-decisions")
    return {
      ...state,
      issues: state.issues.map((item) => ({
        ...item,
        decision: action.decision,
      })),
    };
  if (action.type === "toggle-revision-instruction")
    return {
      ...state,
      revisionInstructionAdditions: action.checked
        ? [
            ...new Set([
              ...state.revisionInstructionAdditions,
              action.instruction,
            ]),
          ]
        : state.revisionInstructionAdditions.filter(
            (item) => item !== action.instruction,
          ),
    };
  if (action.type === "confirm-all")
    return {
      ...state,
      confirmation: {
        fullyRead: true,
        plotAndCharacterApproved: true,
        noUnauthorizedCanon: true,
        continuityApproved: true,
        willingToFinalize: true,
      },
    };
  return {
    ...state,
    confirmation: { ...state.confirmation, [action.key]: action.checked },
  };
}
