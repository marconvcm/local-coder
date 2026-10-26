// Minimal zero-dependency terminal UI: colors, logs, boxes, spinner, and
// interactive prompts (select / confirm / text) using raw-mode stdin.

export const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const colorOn = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (open: number, close: number) => (s: string) =>
  colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgCyan: (s: string) => (colorOn ? `\x1b[46m\x1b[30m${s}\x1b[39m\x1b[49m` : s),
};

export const sym = {
  ok: c.green("✓"),
  warn: c.yellow("!"),
  fail: c.red("✗"),
  info: c.blue("•"),
  step: c.cyan("◆"),
  done: c.green("◇"),
  bar: c.gray("│"),
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visibleLength = (s: string) => s.replace(ANSI, "").length;

/** padEnd that ignores color codes. */
export const padVisible = (s: string, width: number) => s + " ".repeat(Math.max(0, width - visibleLength(s)));
const columns = () => Math.max(40, process.stdout.columns || 80);

/** Truncate plain (uncolored) text to fit the terminal. */
export function clip(text: string, reserve = 6): string {
  const max = columns() - reserve;
  return text.length > max ? text.slice(0, Math.max(1, max - 1)) + "…" : text;
}

function print(prefix: string, message: string) {
  const [first, ...rest] = message.split("\n");
  console.log(`${prefix} ${first}`);
  for (const line of rest) console.log(`  ${line}`);
}

export const log = {
  ok: (m: string) => print(sym.ok, m),
  warn: (m: string) => print(sym.warn, c.yellow(m)),
  fail: (m: string) => print(sym.fail, c.red(m)),
  info: (m: string) => print(sym.info, m),
  note: (m: string) => print(" ", c.gray(m)),
  step: (m: string) => {
    console.log();
    console.log(`${sym.step} ${c.bold(m)}`);
  },
};

export function banner(title: string, subtitle?: string) {
  console.log();
  console.log(`${c.bgCyan(` ${title} `)}${subtitle ? "  " + c.gray(subtitle) : ""}`);
}

/** Rounded box with a title. */
export function box(title: string, lines: string[]) {
  const width = Math.min(
    columns() - 2,
    Math.max(visibleLength(title) + 4, ...lines.map((l) => visibleLength(l) + 4)),
  );
  const rule = "─".repeat(Math.max(0, width - visibleLength(title) - 5));
  console.log();
  console.log(`${c.gray("╭─")} ${c.bold(title)} ${c.gray(rule + "╮")}`);
  for (const line of lines) {
    const pad = Math.max(0, width - visibleLength(line) - 4);
    console.log(`${c.gray("│")} ${line}${" ".repeat(pad)} ${c.gray("│")}`);
  }
  console.log(c.gray(`╰${"─".repeat(width - 2)}╯`));
}

export interface Spinner {
  update(text: string): void;
  stop(message?: string, symbol?: string): void;
}

export function spinner(text: string): Spinner {
  if (!process.stdout.isTTY) {
    console.log(`${sym.info} ${text}…`);
    return {
      update: () => {},
      stop: (message, symbol = sym.ok) => console.log(`${symbol} ${message ?? text}`),
    };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let current = text;
  process.stdout.write("\x1b[?25l");
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[2K${c.cyan(frames[i++ % frames.length]!)} ${current}`);
  }, 80);
  return {
    update: (t) => (current = t),
    stop: (message, symbol = sym.ok) => {
      clearInterval(timer);
      process.stdout.write(`\r\x1b[2K${symbol} ${message ?? current}\n\x1b[?25h`);
    },
  };
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

function requireTTY() {
  if (!isTTY) {
    throw new Error("This prompt needs an interactive terminal. Use --yes and flags instead (see --help).");
  }
}

function restoreTerminal() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
}

process.on("exit", restoreTerminal);

/** Read raw keypresses until `onKey` calls `done`. Ctrl+C exits. */
function readKeys<T>(onKey: (key: string, done: (value: T) => void) => void): Promise<T> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const cleanup = () => {
      stdin.off("data", listener);
      stdin.setRawMode(false);
      stdin.pause();
    };
    let finished = false;
    const listener = (data: string) => {
      // One read can hold several keys (key repeat, fast typing, paste)
      for (const key of data.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b.|[\s\S]/g) ?? []) {
        if (finished) return;
        if (key === "\u0003") {
          cleanup();
          restoreTerminal();
          console.log(`\n${c.gray("Cancelled.")}`);
          process.exit(130);
        }
        onKey(key, (value) => {
          finished = true;
          cleanup();
          resolve(value);
        });
      }
    };
    stdin.on("data", listener);
  });
}

/** Re-renders a block of lines in place. */
function renderer() {
  let height = 0;
  return (lines: string[]) => {
    let out = "";
    if (height > 0) out += `\x1b[${height}A\r`;
    out += "\x1b[0J" + lines.join("\n") + "\n";
    process.stdout.write(out);
    height = lines.length;
  };
}

export interface Option<T> {
  value: T;
  label: string; // may contain colors
  hint?: string; // plain text, shown under the active option
  disabled?: boolean;
}

export async function select<T>(message: string, options: Option<T>[], initialIndex = 0): Promise<T> {
  requireTTY();
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  let index = enabled.includes(initialIndex) ? initialIndex : (enabled[0] ?? 0);
  const draw = renderer();
  process.stdout.write("\x1b[?25l");
  console.log();

  const view = () => {
    const lines = [`${sym.step} ${c.bold(message)}`];
    options.forEach((o, i) => {
      const active = i === index;
      const pointer = active ? c.cyan("❯") : " ";
      const label = o.disabled ? c.dim(o.label) : active ? c.bold(o.label) : o.label;
      lines.push(`${sym.bar} ${pointer} ${label}`);
      if (active && o.hint) lines.push(`${sym.bar}     ${c.gray(clip(o.hint, 8))}`);
    });
    lines.push(c.gray("└  ↑/↓ to move · enter to select · ctrl+c to quit"));
    draw(lines);
  };

  const move = (delta: number) => {
    const pos = enabled.indexOf(index);
    index = enabled[(pos + delta + enabled.length) % enabled.length]!;
  };

  view();
  const value = await readKeys<T>((key, done) => {
    if (key === "\x1b[A" || key === "k") move(-1);
    else if (key === "\x1b[B" || key === "j") move(1);
    else if (key === "\r" || key === "\n") return done(options[index]!.value);
    view();
  });

  draw([`${sym.done} ${message}`, `${sym.bar} ${c.gray(options[index]!.label.replace(ANSI, ""))}`]);
  process.stdout.write("\x1b[?25h");
  return value;
}

export async function confirm(message: string, initial = true): Promise<boolean> {
  requireTTY();
  let value = initial;
  const draw = renderer();
  process.stdout.write("\x1b[?25l");
  console.log();
  const view = () => {
    const yes = value ? `${c.green("●")} ${c.bold("Yes")}` : `${c.gray("○ Yes")}`;
    const no = !value ? `${c.green("●")} ${c.bold("No")}` : `${c.gray("○ No")}`;
    draw([`${sym.step} ${c.bold(message)}`, `${sym.bar} ${yes} ${c.gray("/")} ${no}`, c.gray("└  ←/→ or y/n · enter to confirm")]);
  };
  view();
  const result = await readKeys<boolean>((key, done) => {
    if (["\x1b[C", "\x1b[D", "\t", "h", "l"].includes(key)) value = !value;
    else if (key.toLowerCase() === "y") return done(true);
    else if (key.toLowerCase() === "n") return done(false);
    else if (key === "\r" || key === "\n") return done(value);
    view();
  });
  draw([`${sym.done} ${message}`, `${sym.bar} ${c.gray(result ? "Yes" : "No")}`]);
  process.stdout.write("\x1b[?25h");
  return result;
}

export async function text(
  message: string,
  opts: { initial?: string; placeholder?: string; validate?: (v: string) => string | undefined } = {},
): Promise<string> {
  requireTTY();
  let value = opts.initial ?? "";
  let error: string | undefined;
  const draw = renderer();
  console.log();
  const view = () => {
    const shown = value.length ? value : c.gray(opts.placeholder ?? "");
    const lines = [`${sym.step} ${c.bold(message)}`, `${sym.bar} ${shown}${c.cyan("▏")}`];
    lines.push(error ? c.yellow(`└  ${error}`) : c.gray("└  enter to confirm"));
    draw(lines);
  };
  view();
  const result = await readKeys<string>((key, done) => {
    if (key === "\r" || key === "\n") {
      const final = value.trim() || (opts.placeholder ?? "");
      error = opts.validate?.(final);
      if (!error) return done(final);
    } else if (key === "\x7f" || key === "\b") {
      value = value.slice(0, -1);
      error = undefined;
    } else if (!key.startsWith("\x1b")) {
      value += key.replace(/[\r\n]/g, "");
      error = undefined;
    }
    view();
  });
  draw([`${sym.done} ${message}`, `${sym.bar} ${c.gray(result)}`]);
  return result;
}
