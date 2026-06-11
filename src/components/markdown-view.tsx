/**
 * MarkdownView — thin wrapper around react-markdown with Tailwind styling
 * via arbitrary-variant selectors (no typography plugin installed).
 *
 * No "use client" directive: react-markdown renders fine in server
 * components, and this component is also imported from client components
 * (live edit preview), where it simply becomes part of the client bundle.
 */
import ReactMarkdown from "react-markdown";

const MARKDOWN_CLASSES = [
  "text-sm leading-relaxed text-zinc-700",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_h1]:mb-2 [&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-zinc-900",
  "[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-zinc-900",
  "[&_h3]:mb-1 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-zinc-900",
  "[&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:text-zinc-900",
  "[&_p]:my-2",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:ps-5",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:ps-5",
  "[&_li]:my-0.5",
  "[&_a]:text-blue-600 [&_a]:underline [&_a]:underline-offset-2",
  "[&_strong]:font-semibold [&_strong]:text-zinc-900",
  "[&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-zinc-800",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-900 [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-zinc-100",
  "[&_blockquote]:my-2 [&_blockquote]:border-s-4 [&_blockquote]:border-zinc-200 [&_blockquote]:ps-3 [&_blockquote]:text-zinc-500",
  "[&_hr]:my-4 [&_hr]:border-zinc-200",
].join(" ");

export function MarkdownView({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={`${MARKDOWN_CLASSES} ${className ?? ""}`}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
