import {
  cancel,
  confirm,
  isCancel,
  multiselect,
  select,
  text,
} from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

export type PromptError =
  | { type: "PromptCancelled"; message: string }
  | { type: "PromptUnavailable"; message: string };

export type PromptOption<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

export interface PromptAdapter {
  isInteractive(): boolean;
  select<T extends string>(input: {
    message: string;
    options: PromptOption<T>[];
    initialValue?: T;
  }): Promise<Result<T, PromptError>>;
  multiselect<T extends string>(input: {
    message: string;
    options: PromptOption<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<Result<T[], PromptError>>;
  text(input: {
    message: string;
    defaultValue: string;
    placeholder?: string;
  }): Promise<Result<string, PromptError>>;
  confirm(input: {
    message: string;
    initialValue: boolean;
  }): Promise<Result<boolean, PromptError>>;
  cancel(message: string): Result<void, PromptError>;
}

function unavailable(): PromptError {
  return {
    type: "PromptUnavailable",
    message: "Interactive prompts are unavailable because stdin is not a TTY.",
  };
}

function cancelled(): PromptError {
  return { type: "PromptCancelled", message: "Setup cancelled." };
}

function ensureInteractive(isInteractive: boolean): Result<void, PromptError> {
  if (!isInteractive) return err(unavailable());
  return ok(undefined);
}

export class ClackPromptAdapter implements PromptAdapter {
  isInteractive(): boolean {
    return Boolean(process.stdin.isTTY);
  }

  async select<T extends string>(input: {
    message: string;
    options: PromptOption<T>[];
    initialValue?: T;
  }): Promise<Result<T, PromptError>> {
    const interactive = ensureInteractive(this.isInteractive());
    if (interactive.isErr()) return err(interactive.error);

    const options = input.options.map((option) => {
      if (option.hint === undefined) {
        return { value: option.value, label: option.label };
      }
      return { value: option.value, label: option.label, hint: option.hint };
    });
    const answer = await select<string>({
      message: input.message,
      options,
      initialValue: input.initialValue,
    });
    if (isCancel(answer)) return err(cancelled());
    return ok(answer as T);
  }

  async multiselect<T extends string>(input: {
    message: string;
    options: PromptOption<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<Result<T[], PromptError>> {
    const interactive = ensureInteractive(this.isInteractive());
    if (interactive.isErr()) return err(interactive.error);

    const options = input.options.map((option) => {
      if (option.hint === undefined) {
        return { value: option.value, label: option.label };
      }
      return { value: option.value, label: option.label, hint: option.hint };
    });
    const answer = await multiselect<string>({
      message: input.message,
      options,
      initialValues: input.initialValues,
      required: input.required ?? false,
    });
    if (isCancel(answer)) return err(cancelled());
    return ok(answer as T[]);
  }

  async text(input: {
    message: string;
    defaultValue: string;
    placeholder?: string;
  }): Promise<Result<string, PromptError>> {
    const interactive = ensureInteractive(this.isInteractive());
    if (interactive.isErr()) return err(interactive.error);

    const answer = await text({
      message: input.message,
      placeholder: input.placeholder,
      defaultValue: input.defaultValue,
      initialValue: input.defaultValue,
    });
    if (isCancel(answer)) return err(cancelled());
    return ok(String(answer));
  }

  async confirm(input: {
    message: string;
    initialValue: boolean;
  }): Promise<Result<boolean, PromptError>> {
    const interactive = ensureInteractive(this.isInteractive());
    if (interactive.isErr()) return err(interactive.error);

    const answer = await confirm({
      message: input.message,
      initialValue: input.initialValue,
    });
    if (isCancel(answer)) return err(cancelled());
    return ok(Boolean(answer));
  }

  cancel(message: string): Result<void, PromptError> {
    cancel(message);
    return err({ type: "PromptCancelled", message });
  }
}

export class StaticPromptAdapter implements PromptAdapter {
  constructor(
    private readonly answers: {
      select?: string[];
      multiselect?: string[][];
      text?: string[];
      confirm?: boolean[];
      interactive?: boolean;
      cancelNext?: boolean;
    } = {},
  ) {}

  isInteractive(): boolean {
    return this.answers.interactive ?? true;
  }

  async select<T extends string>(input: {
    message: string;
    options: PromptOption<T>[];
    initialValue?: T;
  }): Promise<Result<T, PromptError>> {
    if (!this.isInteractive()) return err(unavailable());
    if (this.answers.cancelNext) return err(cancelled());
    const next = this.answers.select?.shift() ?? input.initialValue;
    if (next !== undefined) return ok(next as T);
    return ok(input.options[0].value);
  }

  async multiselect<T extends string>(input: {
    message: string;
    options: PromptOption<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<Result<T[], PromptError>> {
    if (!this.isInteractive()) return err(unavailable());
    if (this.answers.cancelNext) return err(cancelled());
    const next = this.answers.multiselect?.shift() ?? input.initialValues ?? [];
    return ok(next as T[]);
  }

  async text(input: {
    message: string;
    defaultValue: string;
    placeholder?: string;
  }): Promise<Result<string, PromptError>> {
    if (!this.isInteractive()) return err(unavailable());
    if (this.answers.cancelNext) return err(cancelled());
    return ok(this.answers.text?.shift() ?? input.defaultValue);
  }

  async confirm(input: {
    message: string;
    initialValue: boolean;
  }): Promise<Result<boolean, PromptError>> {
    if (!this.isInteractive()) return err(unavailable());
    if (this.answers.cancelNext) return err(cancelled());
    return ok(this.answers.confirm?.shift() ?? input.initialValue);
  }

  cancel(message: string): Result<void, PromptError> {
    return err({ type: "PromptCancelled", message });
  }
}
