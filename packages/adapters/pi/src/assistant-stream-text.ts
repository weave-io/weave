/**
 * The one rule for growing a streamed assistant answer.
 *
 * A `text_delta` is a fragment of a sentence, not a sentence: a model splits
 * `hello` into `hel` + `lo` whenever its tokenizer feels like it. Every
 * surface that shows a streamed answer therefore has to CONCATENATE the
 * deltas exactly, in order, and only then decide how to display the result.
 *
 * Doing it the other way round is what broke parity: the card and the compact
 * block each sanitized a delta first and then joined the sanitized fragments
 * with a space, so `["hel", "lo"]` became `hel lo` on the card while the
 * inspector — which did concatenate — said `hello`. Two surfaces reading the
 * same wire disagreed about what the child had said, and neither was quoting
 * it.
 *
 * So accumulation and projection are separated:
 *
 * - {@link appendAssistantStreamDelta} keeps the RAW answer, exactly as sent,
 *   bounded by the same 4 KiB UTF-8 preview budget the delegation tree, the
 *   picker, the card and the inspector all already share;
 * - each surface sanitizes THAT string for display, once, at the end.
 *
 * The accumulator never inspects the delta's content, so two identical deltas
 * are two deltas: a repeated word is not a repeated frame.
 *
 * Raw chain-of-thought cannot enter here, because the only value any caller
 * appends is the `answer` text of the single `message_update` carrier
 * classification.
 */
import { truncateLatestOutput } from "./child-tree.js";

/**
 * Appends one streamed answer delta to the accumulated answer, exactly.
 *
 * No separator, no normalization, no de-duplication. The result is truncated
 * to the shared 4 KiB UTF-8 preview budget at a code-point boundary, so a very
 * long answer keeps its head rather than growing without bound.
 */
export function appendAssistantStreamDelta(
  accumulated: string,
  delta: string,
): string {
  if (delta.length === 0) return accumulated;
  return truncateLatestOutput(accumulated + delta);
}
