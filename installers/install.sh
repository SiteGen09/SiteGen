#!/bin/sh
# sitegen setup for Codex, Claude Code and OpenCode on macOS and Linux.
#
#   Install:    curl -fsSL __SITEGEN_BASE_URL__/install.sh | sh
#   Undo:       curl -fsSL __SITEGEN_BASE_URL__/uninstall.sh | sh
#               (or, offline: sh ~/.sitegen/uninstall.sh)
#
# Points Codex (CLI, desktop app, IDE extension), Claude Code (CLI, IDE
# extensions) and OpenCode (CLI, desktop app) at your sitegen account: GPT
# models for Codex, Claude models for Claude Code, every chat model for
# OpenCode.
#
# Your API key is stored in ~/.sitegen/api-key, readable only by you. The
# apps' settings only point at it (Codex and Claude Code through a small
# helper script, OpenCode through a {file:} reference); the key itself is never
# written into them. Every file this changes is backed up
# to ~/.sitegen/backups first, and --uninstall puts your previous settings back.
#
# Needs curl and Python 3 (on macOS, Apple's command line tools provide it).
#
# Optional environment variables:
#   SITEGEN_TOOLS         codex, claude, opencode, several joined by commas, or
#                         all (skips the question); undo reverts only the named
#                         tools when it is set
#   SITEGEN_OPENCODE_MODEL  default OpenCode model (skips the question)
#   SITEGEN_API_KEY       use this key instead of asking for it
#   SITEGEN_CODEX_MODEL   default Codex model (skips the question)
#   SITEGEN_CLAUDE_MODEL  default Claude Code model (skips the question)
#   SITEGEN_SKIP_TEST=1   skip the final one-message test
#   SITEGEN_BASE_URL      sitegen server (default: the one this script came from)
#   SITEGEN_HOME          where the key and state live (default: ~/.sitegen)

# Everything runs from main, called on the last line, so a download cut short
# never runs half a script.
main() {
  set -eu

  if ! command -v curl >/dev/null 2>&1; then
    echo "sitegen setup needs curl. Install it and run this again." >&2
    exit 1
  fi

  python=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
      path=$(command -v "$candidate")
      # On macOS /usr/bin/python3 is a stub until the command line tools exist,
      # and running it would open an installer dialog mid-setup.
      if [ "$(uname -s)" = "Darwin" ] && [ "$path" = "/usr/bin/python3" ] && ! xcode-select -p >/dev/null 2>&1; then
        continue
      fi
      if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
        python=$candidate
        break
      fi
    fi
  done
  if [ -z "$python" ]; then
    if [ "$(uname -s)" = "Darwin" ]; then
      echo "sitegen setup needs Python 3. Install Apple's command line tools with: xcode-select --install" >&2
      echo "then run this again." >&2
    else
      echo "sitegen setup needs Python 3.8 or newer. Install it (for example: sudo apt install python3) and run this again." >&2
    fi
    exit 1
  fi

  program=$(mktemp "${TMPDIR:-/tmp}/sitegen-setup.XXXXXX")
  trap 'rm -f "$program"' EXIT INT TERM
  cat >"$program" <<'SITEGEN_PYTHON'
import datetime, getpass, json, os, re, shlex, shutil, stat, subprocess, sys, tempfile, threading, time

INSTALLER_VERSION = 2
PROVIDER_ID = "sitegen"
BASE_URL = (os.environ.get("SITEGEN_BASE_URL") or "__SITEGEN_BASE_URL__").rstrip("/")

HOME = os.path.expanduser("~")
SITEGEN_DIR = os.environ.get("SITEGEN_HOME") or os.path.join(HOME, ".sitegen")
KEY_FILE = os.path.join(SITEGEN_DIR, "api-key")
HELPER_FILE = os.path.join(SITEGEN_DIR, "key.sh")
STATE_FILE = os.path.join(SITEGEN_DIR, "state.json")
BACKUP_ROOT = os.path.join(SITEGEN_DIR, "backups")
# A saved copy of this program and a script that runs its undo, so reverting
# needs neither the network nor a long command.
LOCAL_COPY = os.path.join(SITEGEN_DIR, "setup.py")
UNDO_SCRIPT = os.path.join(SITEGEN_DIR, "uninstall.sh")
# /uninstall.sh serves this same script with "uninstall" written in here.
DEFAULT_ACTION = "__SITEGEN_DEFAULT_ACTION__"
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
CODEX_CONFIG = os.path.join(CODEX_HOME, "config.toml")
CODEX_CATALOG = os.path.join(CODEX_HOME, "sitegen-models.json")
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
CLAUDE_SETTINGS = os.path.join(CLAUDE_DIR, "settings.json")
OPENCODE_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "opencode")
TOOL_NAMES = {"codex": "Codex", "claude": "Claude Code", "opencode": "OpenCode"}
TOOL_ORDER = ("codex", "claude", "opencode")

# Every line the installer adds to config.toml is marked, and every line it
# turns off is commented with a prefix, so uninstall can undo exactly that.
BLOCK_START = "# >>> sitegen"
BLOCK_END = "# <<< sitegen"
MANAGED_TAG = "# sitegen-managed"
DISABLED_PREFIX = "# sitegen-disabled: "
TOP_LEVEL_KEYS = ["model", "model_provider", "model_catalog_json", "web_search"]
# Codex features whose tools sitegen's Responses endpoint cannot accept.
DISABLED_FEATURES = ["multi_agent", "view_image"]
# Claude Code settings the installer owns while installed.
CLAUDE_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                   "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_AUTH_TOKEN",
                   "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "CLAUDE_CODE_AUTO_MODE_SERVER"]

COLOR = sys.stdout.isatty()


class SetupError(Exception):
    pass


def paint(code, text):
    return "\033[%sm%s\033[0m" % (code, text) if COLOR else text


def say(text=""):
    stop_spinner()
    print(text, flush=True)


def step(text):
    say()
    say(paint("36", text))


def ok(text):
    say(paint("32", "  OK  " + text))


def warn(text):
    say(paint("33", "  !   " + text))


# Braille frames need a UTF-8 terminal; anything else gets plain ASCII.
SPINNER_FRAMES = ("\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f"
                  if re.sub(r"[-_]", "", (sys.stdout.encoding or "").lower()) == "utf8" else "|/-\\")
_spinner = []


class working(object):
    """Shows a spinner and the seconds elapsed while a slow step runs.

    Anything printed meanwhile (a warning, say) ends the spinner first, so its
    line never mixes with real output. Without a terminal it prints one line."""

    def __init__(self, text):
        self.text = text
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.spin)
        self.thread.daemon = True

    def __enter__(self):
        if not COLOR:
            say("  ..  " + self.text)
            return self
        stop_spinner()
        _spinner.append(self)
        self.thread.start()
        return self

    def __exit__(self, *exc):
        stop_spinner()

    def spin(self):
        started = time.time()
        frame = 0
        while True:
            seconds = int(time.time() - started)
            sys.stdout.write("\r\033[K  %s   %s%s" % (paint("36", SPINNER_FRAMES[frame % len(SPINNER_FRAMES)]), self.text,
                                                       paint("2", " (%ds)" % seconds) if seconds >= 3 else ""))
            sys.stdout.flush()
            frame += 1
            if self.done.wait(0.1):
                break
        sys.stdout.write("\r\033[K")
        sys.stdout.flush()


def stop_spinner():
    while _spinner:
        spinner = _spinner.pop()
        spinner.done.set()
        spinner.thread.join()


def write_private(path, text, mode=0o600):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(path, mode)


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def new_backup_dir():
    path = os.path.join(BACKUP_ROOT, datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    os.makedirs(path, exist_ok=True)
    return path


def backup(path, directory, name):
    if os.path.exists(path):
        shutil.copy2(path, os.path.join(directory, name))


def toml_string(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


# ---------------------------------------------------------------- HTTP

def request(method, path, key, body=None, headers=None):
    """Calls sitegen through curl, which uses the system's certificates.

    The key travels in a curl config read from stdin, never on the command
    line where other users could see it in the process list."""
    config = ['url = "%s%s"' % (BASE_URL, path), 'header = "Authorization: Bearer %s"' % key]
    for name, value in (headers or {}).items():
        config.append('header = "%s: %s"' % (name, value))
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "out")
        cmd = ["curl", "-sS", "-X", method, "--max-time", "90", "-o", out, "-w", "%{http_code}", "--config", "-"]
        if body is not None:
            payload = os.path.join(tmp, "body")
            with open(payload, "w", encoding="utf-8") as handle:
                json.dump(body, handle)
            cmd += ["-H", "Content-Type: application/json", "--data-binary", "@" + payload]
        result = subprocess.run(cmd, input="\n".join(config) + "\n", capture_output=True, text=True)
        text = ""
        if os.path.exists(out):
            with open(out, encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        if result.returncode != 0:
            return 0, (result.stderr.strip() or "network error")
        return int(result.stdout.strip() or 0), text


def error_message(text):
    try:
        data = json.loads(text)
        err = data.get("error")
        if isinstance(err, str):
            return err
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])
    except (ValueError, AttributeError):
        pass
    return text[:200]


# ---------------------------------------------------------------- input

def interactive():
    return sys.stdin.isatty()


def read_api_key():
    if os.environ.get("SITEGEN_API_KEY"):
        return os.environ["SITEGEN_API_KEY"].strip()
    if not interactive():
        raise SetupError("No terminal to ask for your API key. Set SITEGEN_API_KEY and run again.")
    say("  Create a key at %s/dashboard/keys (it is shown only once), then paste it here." % BASE_URL)
    for _ in range(3):
        key = getpass.getpass("  API key (typing is hidden): ").strip()
        if re.fullmatch(r"sk_live_[A-Za-z0-9]{32,64}", key):
            return key
        warn("That does not look like a sitegen key (it starts with sk_live_). Try again.")
    raise SetupError("No valid API key was entered.")


def select_model(title, ids, default, override):
    if override:
        if override in ids:
            return override
        warn("%s is not available to this key; using %s instead." % (override, default))
        return default
    if not interactive():
        return default
    ordered = [default] + [i for i in ids if i != default]
    say()
    say("  " + title)
    for index, model in enumerate(ordered, 1):
        say("    %2d. %s%s" % (index, model, "  (recommended)" if index == 1 else ""))
    while True:
        answer = input("  Press Enter for 1, or type a number: ").strip()
        if answer == "":
            return ordered[0]
        if answer.isdigit() and 1 <= int(answer) <= len(ordered):
            return ordered[int(answer) - 1]
        if answer in ordered:
            return answer
        warn("Type a number from 1 to %d." % len(ordered))


# ---------------------------------------------------------------- models

def gpt_rank(model_id):
    """Newest first. GPT tiers: astra > sol > (none) > terra > luna > mini > nano."""
    version = 0
    match = re.match(r"gpt-(\d+)(?:[.-](\d+))?", model_id)
    if match:
        version = int(match.group(1)) * 100 + int(match.group(2) or 0)
    tier = 3
    for word, rank in (("astra", 6), ("sol", 5), ("terra", 2), ("luna", 1), ("mini", 0), ("nano", -1)):
        if re.search(r"(^|[-.])%s($|[-.])" % word, model_id):
            tier = rank
            break
    return version * 10 + tier


def claude_version(model_id):
    match = re.match(r"claude-[a-z]+-(\d+)(?:-(\d+))?(?:-|$)", model_id)
    if match:
        minor = match.group(2)
        return int(match.group(1)) * 100 + (int(minor) if minor and len(minor) <= 2 else 0)
    match = re.match(r"claude-(\d+)(?:-(\d+))?-", model_id)
    if match:
        return int(match.group(1)) * 100 + int(match.group(2) or 0)
    return 0


def claude_best(ids, family):
    matching = [i for i in ids if re.search(r"(^|-)%s(-|$)" % family, i)]
    matching.sort(key=claude_version, reverse=True)
    return matching[0] if matching else None


def first_of(*values):
    for value in values:
        if value:
            return value
    return None


# ---------------------------------------------------------------- tools

def find_codex():
    found = shutil.which("codex")
    if found:
        return found
    # The desktop app carries its own copy of the CLI.
    for app in ("/Applications/Codex.app", os.path.join(HOME, "Applications", "Codex.app")):
        contents = os.path.join(app, "Contents")
        for root, dirs, files in os.walk(contents):
            if root[len(contents):].count(os.sep) >= 3:
                dirs[:] = []
            if "codex" in files:
                candidate = os.path.join(root, "codex")
                if os.access(candidate, os.X_OK):
                    return candidate
    return None


def find_claude():
    found = shutil.which("claude")
    if found:
        return found
    for candidate in (os.path.join(HOME, ".local", "bin", "claude"), os.path.join(HOME, ".claude", "local", "claude")):
        if os.access(candidate, os.X_OK):
            return candidate
    return None


def find_opencode():
    found = shutil.which("opencode")
    if found:
        return found
    for candidate in (os.path.join(HOME, ".opencode", "bin", "opencode"), "/Applications/OpenCode.app",
                      os.path.join(HOME, "Applications", "OpenCode.app")):
        if os.path.exists(candidate):
            return candidate
    return None


def opencode_config_path():
    """The file OpenCode reads: opencode.json, or the .jsonc variant already in use."""
    json_path = os.path.join(OPENCODE_DIR, "opencode.json")
    jsonc_path = os.path.join(OPENCODE_DIR, "opencode.jsonc")
    if not os.path.exists(json_path) and os.path.exists(jsonc_path):
        return jsonc_path
    return json_path


def read_jsonc(path):
    """JSON with comments and trailing commas, as OpenCode allows, read as
    JSON. Comments do not survive the rewrite; the original text is kept so
    undo can put it back as it was."""
    if not os.path.exists(path):
        return {}, False
    with open(path, encoding="utf-8-sig") as handle:
        return parse_jsonc(handle.read(), path)


def parse_jsonc(raw, path):
    out, i, in_string, escaped, had_comments = [], 0, False, False, False
    while i < len(raw):
        ch = raw[i]
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if raw.startswith("//", i):
            had_comments = True
            end = raw.find("\n", i)
            i = len(raw) if end < 0 else end
            continue
        if raw.startswith("/*", i):
            had_comments = True
            end = raw.find("*/", i + 2)
            i = len(raw) if end < 0 else end + 2
            continue
        out.append(ch)
        i += 1
    clean = re.sub(r",(\s*[\]}])", r"\1", "".join(out))
    if clean.strip() == "":
        return {}, had_comments
    value = json.loads(clean)
    if not isinstance(value, dict):
        raise ValueError("%s does not contain a JSON object" % path)
    return value, had_comments


def opencode_key_ref():
    """The {file:...} reference OpenCode resolves itself; ~ keeps it portable."""
    if os.path.abspath(SITEGEN_DIR) == os.path.join(HOME, ".sitegen"):
        return "{file:~/.sitegen/api-key}"
    return "{file:%s}" % KEY_FILE


def install_opencode(ids, model, small_model, state, backup_dir):
    path = opencode_config_path()
    try:
        config, had_comments = read_jsonc(path)
    except ValueError:
        warn("%s could not be read as JSON, so OpenCode was left unchanged. Fix it and run this again." % path)
        return None
    backup(path, backup_dir, "opencode-" + os.path.basename(path))
    providers = config.get("provider") if isinstance(config.get("provider"), dict) else {}

    # As for Claude Code, the values from before the FIRST install are kept.
    previous = ((state or {}).get("opencode") or {}).get("previous")
    if previous is None:
        original = None
        if os.path.exists(path):
            with open(path, encoding="utf-8-sig") as handle:
                original = handle.read()
        previous = {
            "model": config.get("model"),
            "small_model": config.get("small_model"),
            "provider": providers.get(PROVIDER_ID),
            "hadProviders": "provider" in config,
            "fileExisted": original is not None,
            "original": original,
        }

    providers[PROVIDER_ID] = {
        "npm": "@ai-sdk/openai-compatible",
        "name": "sitegen",
        "options": {"baseURL": BASE_URL + "/v1", "apiKey": opencode_key_ref()},
        "models": {model_id: {"name": model_id} for model_id in ids},
    }
    config.setdefault("$schema", "https://opencode.ai/config.json")
    config["provider"] = providers
    config["model"] = "%s/%s" % (PROVIDER_ID, model)
    config["small_model"] = "%s/%s" % (PROVIDER_ID, small_model)
    write_json(path, config)
    if had_comments:
        warn("Comments in %s are left out while sitegen is set up; undo puts the file back with them." % path)
    return {
        "config": path,
        "previous": previous,
        "applied": {"model": config["model"], "small_model": config["small_model"], "baseURL": BASE_URL + "/v1"},
    }


def uninstall_opencode(opencode_state, backup_dir):
    path = opencode_state.get("config")
    if not path or not os.path.exists(path):
        return
    config, _ = read_jsonc(path)
    backup(path, backup_dir, "opencode-" + os.path.basename(path))
    previous = opencode_state.get("previous") or {}
    applied = opencode_state.get("applied") or {}
    for name in ("model", "small_model"):
        if config.get(name) == applied.get(name):
            if previous.get(name) is None:
                config.pop(name, None)
            else:
                config[name] = previous[name]
    providers = config.get("provider")
    if isinstance(providers, dict):
        # Only the provider block this installer wrote is replaced.
        current = providers.get(PROVIDER_ID)
        if isinstance(current, dict) and (current.get("options") or {}).get("baseURL") == applied.get("baseURL"):
            if previous.get("provider") is None:
                providers.pop(PROVIDER_ID, None)
            else:
                providers[PROVIDER_ID] = previous["provider"]
        if not providers and not previous.get("hadProviders"):
            config.pop("provider", None)
    original = previous.get("original")
    if previous.get("fileExisted") is False and not [k for k in config if k != "$schema"]:
        os.remove(path)
    elif original is not None and parse_jsonc(original, path)[0] == config:
        # Nothing else changed since, so the file goes back byte for byte,
        # comments and all.
        write_text(path, original)
    else:
        write_json(path, config)


def run(cmd, env_overrides=None):
    env = dict(os.environ)
    env.update(env_overrides or {})
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=120)
        return result.returncode, result.stdout
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)


def bundled_catalog(codex):
    """Codex's own built-in catalog, read from a clean home so the user's
    current catalog (which may already be this installer's) is never the template."""
    with tempfile.TemporaryDirectory(prefix="sitegen-codex-") as temp:
        code, output = run([codex, "debug", "models"], {"CODEX_HOME": temp})
    start = output.find("{")
    if code != 0 or start < 0:
        return None
    try:
        return json.loads(output[start:])
    except ValueError:
        return None


def input_modalities(model_id):
    """Codex refuses to attach a pasted image unless the model lists "image".
    GPT models read images, except these text-only ones."""
    if re.match(r"(gpt-3|gpt-oss|o1-mini|o1-preview|o3-mini)", model_id):
        return ["text"]
    return ["text", "image"]


def codex_catalog(bundled, ids):
    """One catalog entry per sitegen GPT model, cloned from the closest
    built-in model so Codex keeps its own instructions, then limited to what
    sitegen's Responses endpoint serves: plain function tools, text and image
    input, no hosted search, no priority tier, no "responses lite" or
    code-mode tools."""
    models = bundled.get("models") or []
    listed = sorted((m for m in models if m.get("visibility") == "list"), key=lambda m: int(m.get("priority") or 0))
    fallback = listed[0] if listed else models[0]
    levels = [level for level in fallback.get("supported_reasoning_levels") or [] if level.get("effort") != "ultra"]
    effort_names = [level.get("effort") for level in levels]
    entries = []
    for priority, model_id in enumerate(ids, 1):
        norm = model_id.replace(".", "-")
        template = next((m for m in models if str(m.get("slug", "")).replace(".", "-") == norm), fallback)
        entry = json.loads(json.dumps(template))
        entry.update({
            "slug": model_id,
            "display_name": model_id,
            "description": "%s through sitegen" % model_id,
            "visibility": "list",
            "supported_in_api": True,
            "priority": priority,
            "apply_patch_tool_type": None,
            "supports_search_tool": False,
            "use_responses_lite": False,
            "input_modalities": input_modalities(model_id),
            "service_tiers": [],
            "additional_speed_tiers": [],
            "availability_nux": None,
            "upgrade": None,
            "supported_reasoning_levels": levels,
        })
        if entry.get("default_reasoning_level") not in effort_names:
            entry["default_reasoning_level"] = "medium"
        for name in ("tool_mode", "multi_agent_version", "multi_agent_reasoning_effort"):
            entry.pop(name, None)
        entries.append(entry)
    return {"models": entries}


# ---------------------------------------------------------------- config.toml

TABLE_HEADER = re.compile(r"""^\s*\[\[?\s*[A-Za-z0-9_\-."']+(\s*\.\s*[A-Za-z0-9_\-."']+)*\s*\]\]?\s*(#.*)?$""")
PROVIDER_HEADER = re.compile(r"""^\s*\[\s*model_providers\s*\.\s*["']?%s["']?\s*[\].]""" % PROVIDER_ID)
PROVIDER_POINTER = re.compile(r"""^\s*model_provider\s*=\s*["']%s["']\s*(#.*)?$""" % PROVIDER_ID)
FEATURES_HEADER = re.compile(r"^\s*\[\s*features\s*\]")
TOP_KEY = re.compile(r"^\s*(%s)\s*=" % "|".join(TOP_LEVEL_KEYS))
FEATURE_KEY = re.compile(r"^\s*(%s)\s*=" % "|".join(DISABLED_FEATURES))


def remove_sitegen_toml(lines, fallback=False):
    """Removes everything a previous install added and re-enables what it
    disabled. fallback (uninstall only) also drops a sitegen provider table or
    pointer that lost its markers, e.g. in a config another tool rewrote."""
    out = []
    skip = False
    in_provider = False
    for line in lines:
        if line.startswith(BLOCK_START):
            skip = True
            continue
        if skip:
            if line.startswith(BLOCK_END):
                skip = False
            continue
        if line.rstrip().endswith(MANAGED_TAG):
            continue
        if line.startswith(DISABLED_PREFIX):
            out.append(line[len(DISABLED_PREFIX):])
            continue
        if not fallback:
            out.append(line)
            continue
        if TABLE_HEADER.match(line):
            in_provider = bool(PROVIDER_HEADER.match(line))
        if in_provider or PROVIDER_POINTER.match(line):
            continue
        out.append(line)
    while out and out[-1].strip() == "":
        out.pop()
    return out


def add_sitegen_toml(lines, model, auth_command, auth_args):
    out = [
        BLOCK_START + " (added by the sitegen installer; remove with its uninstall command)",
        "model_provider = " + toml_string(PROVIDER_ID),
        "model = " + toml_string(model),
        "model_catalog_json = " + toml_string(CODEX_CATALOG),
        'web_search = "disabled"',
        BLOCK_END,
    ]
    section = "top"
    saw_features = False
    for line in lines:
        if TABLE_HEADER.match(line):
            if PROVIDER_HEADER.match(line):
                section = "provider"
            elif FEATURES_HEADER.match(line):
                section = "features"
            else:
                section = "other"
            if section == "provider":
                out.append(DISABLED_PREFIX + line)
                continue
            out.append(line)
            if section == "features":
                saw_features = True
                out.extend("%s = false %s" % (name, MANAGED_TAG) for name in DISABLED_FEATURES)
            continue
        blank = line.strip() == ""
        if (section == "provider" and not blank) or (section == "top" and TOP_KEY.match(line)) or (
                section == "features" and FEATURE_KEY.match(line)):
            out.append(DISABLED_PREFIX + line)
            continue
        out.append(line)

    tail = []
    if not saw_features:
        tail += [BLOCK_START + " features", "[features]"] + ["%s = false" % name for name in DISABLED_FEATURES] + [BLOCK_END]
    tail += [
        BLOCK_START + " provider",
        "[model_providers.%s]" % PROVIDER_ID,
        'name = "sitegen"',
        "base_url = " + toml_string(BASE_URL + "/v1"),
        'wire_api = "responses"',
        "",
        "[model_providers.%s.auth]" % PROVIDER_ID,
        "command = " + toml_string(auth_command),
        "args = [" + ", ".join(toml_string(arg) for arg in auth_args) + "]",
        "timeout_ms = 15000",
        "refresh_interval_ms = 3600000",
        BLOCK_END,
    ]
    if out and out[-1].strip() != "":
        out.append("")
    return out + tail


def read_toml():
    if not os.path.exists(CODEX_CONFIG):
        return [], "\n"
    with open(CODEX_CONFIG, encoding="utf-8-sig", newline="") as handle:
        raw = handle.read()
    newline = "\r\n" if "\r\n" in raw else "\n"
    lines = re.split(r"\r?\n", raw)
    if lines and lines[-1] == "":
        lines.pop()
    return lines, newline


def write_toml(lines, newline):
    write_text(CODEX_CONFIG, newline.join(lines) + newline)


# ---------------------------------------------------------------- state

def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as handle:
        raw = handle.read()
    if raw.strip() == "":
        return default
    return json.loads(raw)


def write_json(path, value, compact=False):
    text = json.dumps(value, separators=(",", ":")) if compact else json.dumps(value, indent=2, ensure_ascii=False)
    write_text(path, text + "\n")


# ---------------------------------------------------------------- install

def install_codex(codex, gpt_ids, model, backup_dir):
    bundled = bundled_catalog(codex)
    if not bundled or not bundled.get("models"):
        warn("Could not read Codex's built-in model list. Update Codex and run this again.")
        return False
    write_json(CODEX_CATALOG, codex_catalog(bundled, gpt_ids), compact=True)

    lines, newline = read_toml()
    existed = os.path.exists(CODEX_CONFIG)
    backup(CODEX_CONFIG, backup_dir, "codex-config.toml")
    updated = add_sitegen_toml(remove_sitegen_toml(lines), model, "/bin/sh", [HELPER_FILE])
    write_toml(updated, newline)

    # Codex itself is the judge of whether the edited config is valid.
    code, output = run([codex, "debug", "models"], {"CODEX_HOME": CODEX_HOME})
    if code != 0 or ('"slug":"%s"' % model) not in output:
        if existed:
            shutil.copy2(os.path.join(backup_dir, "codex-config.toml"), CODEX_CONFIG)
        elif os.path.exists(CODEX_CONFIG):
            os.remove(CODEX_CONFIG)
        if os.path.exists(CODEX_CATALOG):
            os.remove(CODEX_CATALOG)
        warn("Codex did not accept the new settings, so your previous Codex config was put back.")
        warn("Update Codex and run this again.")
        return False
    return True


def install_claude(model, tiers, state, backup_dir):
    try:
        settings = read_json(CLAUDE_SETTINGS, {})
    except ValueError:
        warn("%s is not valid JSON, so Claude Code was left unchanged. Fix or remove it and run this again." % CLAUDE_SETTINGS)
        return None
    if not isinstance(settings, dict):
        warn("%s does not contain a JSON object, so Claude Code was left unchanged." % CLAUDE_SETTINGS)
        return None
    backup(CLAUDE_SETTINGS, backup_dir, "claude-settings.json")
    env = settings.get("env") if isinstance(settings.get("env"), dict) else {}

    # The values from before the FIRST install are what uninstall restores, so
    # a re-install keeps the originals instead of recording its own values.
    previous = ((state or {}).get("claude") or {}).get("previous")
    if previous is None:
        previous = {
            "apiKeyHelper": settings.get("apiKeyHelper"),
            "model": settings.get("model"),
            "env": {name: env.get(name) for name in CLAUDE_ENV_KEYS},
            "hadEnv": "env" in settings,
            "fileExisted": os.path.exists(CLAUDE_SETTINGS),
        }
    else:
        # Keys added to CLAUDE_ENV_KEYS since the first install record their value now.
        previous_env = previous.setdefault("env", {})
        for name in CLAUDE_ENV_KEYS:
            if name not in previous_env:
                previous_env[name] = env.get(name)

    helper = "/bin/sh " + shlex.quote(HELPER_FILE)
    applied_env = {
        "ANTHROPIC_BASE_URL": BASE_URL,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": tiers["opus"],
        "ANTHROPIC_DEFAULT_SONNET_MODEL": tiers["sonnet"],
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": tiers["haiku"],
        "ANTHROPIC_SMALL_FAST_MODEL": tiers["haiku"],
        # sitegen cannot run auto mode's server-side classifier checks, so
        # Claude Code makes its own and skips the "isn't eligible" notice.
        "CLAUDE_CODE_AUTO_MODE_SERVER": "0",
    }
    env.update(applied_env)
    # A token or pinned model left in the settings would override the helper.
    for name in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"):
        env.pop(name, None)
    settings["env"] = env
    settings["apiKeyHelper"] = helper
    settings["model"] = model
    write_json(CLAUDE_SETTINGS, settings)
    return {
        "settingsPath": CLAUDE_SETTINGS,
        "previous": previous,
        "applied": {"apiKeyHelper": helper, "model": model, "env": applied_env},
    }


def test_route(key, kind, model):
    if kind == "opencode":
        status, text = request("POST", "/v1/chat/completions", key,
                               {"model": model, "max_tokens": 32,
                                "messages": [{"role": "user", "content": "Reply with the single word OK."}]})
    elif kind == "codex":
        status, text = request("POST", "/v1/responses", key,
                               {"model": model, "input": "Reply with the single word OK.", "max_output_tokens": 32})
    else:
        status, text = request("POST", "/v1/messages", key,
                               {"model": model, "max_tokens": 32,
                                "messages": [{"role": "user", "content": "Reply with the single word OK."}]},
                               {"anthropic-version": "2023-06-01"})
    if status == 200:
        return None
    return "HTTP %s: %s" % (status, error_message(text))


def tools_filter():
    """SITEGEN_TOOLS as a set of tool ids; unset, 'all' or 'both' means every tool."""
    raw = (os.environ.get("SITEGEN_TOOLS") or "all").lower()
    every = "all" in raw or "both" in raw
    wanted = {tool: every or tool in raw for tool in TOOL_ORDER}
    if not any(wanted.values()):
        raise SetupError("SITEGEN_TOOLS must name codex, claude or opencode, or be all (it is '%s')."
                         % os.environ.get("SITEGEN_TOOLS"))
    wanted["explicit"] = bool(os.environ.get("SITEGEN_TOOLS"))
    return wanted


def select_tools(can):
    """Which of the available tools to set up. The ones left out are not touched."""
    wanted = tools_filter()
    available = [tool for tool in TOOL_ORDER if can.get(tool)]
    pick = {tool: bool(can.get(tool)) and wanted[tool] for tool in TOOL_ORDER}
    if wanted["explicit"] or len(available) < 2 or not interactive():
        return pick
    say()
    say("  What should sitegen set up? Tools you leave out stay exactly as they are.")
    say("     1. All of them: %s  (recommended)" % ", ".join(TOOL_NAMES[t] for t in available))
    for index, tool in enumerate(available, 2):
        say("     %d. %s" % (index, TOOL_NAMES[tool]))
    while True:
        answer = input("  Press Enter for 1, or type one number or several (for example 2,3): ").strip()
        numbers = [n for n in re.split(r"[,\s]+", answer) if n]
        if not numbers or "1" in numbers:
            return {tool: tool in available for tool in TOOL_ORDER}
        if all(n.isdigit() and 2 <= int(n) <= len(available) + 1 for n in numbers):
            chosen = {available[int(n) - 2] for n in numbers}
            return {tool: tool in chosen for tool in TOOL_ORDER}
        warn("Type numbers from 1 to %d." % (len(available) + 1))


def install_undo_script():
    """Saves this program next to the key with a one-command undo for it."""
    try:
        here = os.path.abspath(__file__)
        if here != os.path.abspath(LOCAL_COPY):
            with open(here, encoding="utf-8") as source:
                write_private(LOCAL_COPY, source.read())
        write_private(UNDO_SCRIPT,
                      "#!/bin/sh\n"
                      "# Puts Codex and Claude Code back to how they were before sitegen setup.\n"
                      "exec %s %s --uninstall \"$@\"\n" % (shlex.quote(sys.executable), shlex.quote(LOCAL_COPY)), 0o700)
        return UNDO_SCRIPT
    except OSError:
        return None


def install():
    say()
    say(paint("1", "sitegen setup for Codex, Claude Code and OpenCode"))
    say("Server: " + BASE_URL)

    step("1. Your sitegen API key")
    key = read_api_key()
    with working("Checking your key"):
        status, text = request("GET", "/v1/models", key)
    if status == 401:
        raise SetupError("sitegen did not accept that key. Check that you copied all of it, or create a new one.")
    if status == 403:
        raise SetupError("That key cannot chat. Create a key with the chat permission and run this again.")
    if status != 200:
        raise SetupError("Could not reach sitegen (%s): %s" % (status, error_message(text)))
    ids = [str(item.get("id")) for item in (json.loads(text).get("data") or []) if item.get("id")]
    gpt = sorted((i for i in ids if re.match(r"(gpt-|o\d|codex-)", i)), key=lambda i: (-gpt_rank(i), i))
    claude = sorted((i for i in ids if i.startswith("claude-")), key=lambda i: (-claude_version(i), i))
    # OpenCode speaks the chat completions format, which serves every family.
    everything = claude + gpt + sorted(i for i in ids if i not in gpt and i not in claude)
    ok("Key accepted: %d models (%d GPT, %d Claude)." % (len(ids), len(gpt), len(claude)))

    step("2. Looking for Codex, Claude Code and OpenCode")
    codex = find_codex()
    claude_exe = find_claude()
    opencode_exe = find_opencode()
    opencode_found = bool(opencode_exe) or os.path.isdir(OPENCODE_DIR)
    if codex:
        ok("Codex found: " + codex)
    else:
        warn("Codex was not found. Install it first (npm i -g @openai/codex, or the Codex app), then run this again to set it up.")
    if claude_exe:
        ok("Claude Code found: " + claude_exe)
    else:
        warn("Claude Code was not found. Its settings will still be written, ready for when you install it "
             "(curl -fsSL https://claude.ai/install.sh | bash).")
    if opencode_exe:
        ok("OpenCode found: " + opencode_exe)
    elif opencode_found:
        ok("OpenCode settings found: " + OPENCODE_DIR)
    else:
        warn("OpenCode was not found (https://opencode.ai). Install it and run this again to set it up too.")
    if codex and not gpt:
        warn("Your plan has no GPT models, so Codex was left unchanged.")
    if not claude:
        warn("Your plan has no Claude models, so Claude Code was left unchanged.")
    # Named explicitly, OpenCode is set up even before it is installed.
    opencode_wanted = opencode_found or "opencode" in (os.environ.get("SITEGEN_TOOLS") or "").lower()
    tools = select_tools({"codex": bool(codex) and bool(gpt), "claude": bool(claude),
                          "opencode": opencode_wanted and bool(ids)})
    do_codex, do_claude, do_opencode = tools["codex"], tools["claude"], tools["opencode"]
    if not do_codex and not do_claude and not do_opencode:
        raise SetupError("Nothing to set up.")

    codex_model = claude_model = tiers = opencode_model = opencode_small = None
    if do_codex:
        codex_model = select_model("Default model for Codex (you can switch any time with /model):", gpt, gpt[0],
                                   os.environ.get("SITEGEN_CODEX_MODEL"))
    if do_claude:
        opus = first_of(claude_best(claude, "opus"), claude_best(claude, "fable"), claude_best(claude, "sonnet"), claude[0])
        sonnet = first_of(claude_best(claude, "sonnet"), opus)
        haiku = first_of(claude_best(claude, "haiku"), sonnet)
        tiers = {"opus": opus, "sonnet": sonnet, "haiku": haiku}
        claude_model = select_model("Default model for Claude Code (you can switch any time with /model):", claude, opus,
                                    os.environ.get("SITEGEN_CLAUDE_MODEL"))
    if do_opencode:
        best = first_of(claude_best(claude, "opus"), claude_best(claude, "sonnet"), gpt[0] if gpt else None, everything[0])
        opencode_model = select_model("Default model for OpenCode (you can switch any time with /models):", everything,
                                      best, os.environ.get("SITEGEN_OPENCODE_MODEL"))
        # Session titles and summaries go to a small, cheap model.
        opencode_small = first_of(claude_best(claude, "haiku"),
                                  next((i for i in gpt if re.search(r"mini|nano|luna", i)), None), opencode_model)

    step("3. Saving your key securely")
    os.makedirs(SITEGEN_DIR, exist_ok=True)
    os.chmod(SITEGEN_DIR, 0o700)
    write_private(KEY_FILE, key)
    write_private(HELPER_FILE,
                  "#!/bin/sh\n"
                  "# sitegen: prints your API key for Codex and Claude Code. Written by the sitegen installer.\n"
                  "exec cat %s\n" % shlex.quote(KEY_FILE), 0o700)
    code, printed = run(["/bin/sh", HELPER_FILE])
    if code != 0 or printed.strip() != key:
        raise SetupError("The key helper could not read the saved key back. Nothing else was changed.")
    ok("Key saved in %s (readable only by you)" % SITEGEN_DIR)

    try:
        state = read_json(STATE_FILE)
    except ValueError:
        state = None
    backup_dir = new_backup_dir()
    # A tool left out this time keeps what an earlier run recorded, so undo can
    # still put it back.
    new_state = {"version": INSTALLER_VERSION, "baseUrl": BASE_URL,
                 "installedAt": datetime.datetime.now().isoformat(),
                 "codex": None if do_codex else (state or {}).get("codex"),
                 "claude": None if do_claude else (state or {}).get("claude"),
                 "opencode": None if do_opencode else (state or {}).get("opencode")}

    step("4. Setting up the apps")
    if do_codex:
        with working("Setting up Codex (checking that Codex accepts the new settings)"):
            codex_done = install_codex(codex, gpt, codex_model, backup_dir)
        if codex_done:
            new_state["codex"] = {"home": CODEX_HOME, "config": CODEX_CONFIG, "catalog": CODEX_CATALOG, "model": codex_model}
            ok("Codex now uses sitegen (%s by default, %d models in its picker)." % (codex_model, len(gpt)))
    if do_claude:
        with working("Setting up Claude Code"):
            result = install_claude(claude_model, tiers, state, backup_dir)
        if result is not None:
            new_state["claude"] = result
            ok("Claude Code now uses sitegen (%s by default; opus=%s, sonnet=%s, haiku=%s)."
               % (claude_model, tiers["opus"], tiers["sonnet"], tiers["haiku"]))
    if do_opencode:
        with working("Setting up OpenCode"):
            result = install_opencode(everything, opencode_model, opencode_small, state, backup_dir)
        if result is not None:
            new_state["opencode"] = result
            ok("OpenCode now uses sitegen (%s by default, %d models under the sitegen provider)."
               % (opencode_model, len(everything)))
    write_private(STATE_FILE, json.dumps(new_state, indent=2) + "\n")
    say("  Backups of your previous settings: " + backup_dir)
    undo_script = install_undo_script()

    if not os.environ.get("SITEGEN_SKIP_TEST"):
        step("5. Sending one short test message")
        if do_codex and new_state["codex"]:
            with working("Waiting for Codex to answer (%s)" % codex_model):
                err = test_route(key, "codex", codex_model)
            if err:
                warn("Codex route test failed: " + err)
            else:
                ok("Codex route answered (%s)." % codex_model)
        if do_claude and new_state["claude"]:
            with working("Waiting for Claude Code to answer (%s)" % claude_model):
                err = test_route(key, "claude", claude_model)
            if err:
                warn("Claude Code route test failed: " + err)
            else:
                ok("Claude Code route answered (%s)." % claude_model)
        if do_opencode and new_state["opencode"]:
            with working("Waiting for OpenCode to answer (%s)" % opencode_model):
                err = test_route(key, "opencode", opencode_model)
            if err:
                warn("OpenCode route test failed: " + err)
            else:
                ok("OpenCode route answered (%s)." % opencode_model)

    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"):
        if os.environ.get(name):
            warn("%s is set in your shell (check ~/.zshrc, ~/.bashrc or ~/.profile) and may override these settings. "
                 "Remove it if Claude Code does not use sitegen." % name)

    say()
    say(paint("32", "Done."))
    for name, done, label, hint in (
            ("codex", do_codex, "Codex:       ", "restart the Codex app if it is open, or run: codex"),
            ("claude", do_claude, "Claude Code: ", "open a new terminal and run: claude  (IDE extensions pick it up on restart)"),
            ("opencode", do_opencode, "OpenCode:    ", "restart the OpenCode app if it is open, or run: opencode")):
        if done and new_state[name]:
            say("  %s %s" % (label, hint))
        elif new_state[name]:
            say("  %s not changed this time (still on sitegen from an earlier setup)" % label)
        else:
            say("  %s not changed" % label)
    say()
    say("  To go back to your previous setup, run:")
    if undo_script:
        short = "~" + undo_script[len(HOME):] if undo_script.startswith(HOME + os.sep) else undo_script
        # A quoted ~ would not expand, so only quote a path that needs it.
        say("    sh " + (short if re.fullmatch(r"[~\w./-]+", short) else shlex.quote(undo_script)))
        say("  or")
    say("    curl -fsSL %s/uninstall.sh | sh" % BASE_URL)


# ---------------------------------------------------------------- uninstall

def uninstall():
    wanted = tools_filter()
    names = ", ".join(TOOL_NAMES[t] for t in TOOL_ORDER if wanted[t])
    say()
    say(paint("1", "Putting %s back to how they were before sitegen setup" % names))
    try:
        state = read_json(STATE_FILE)
    except ValueError:
        state = None
    backup_dir = new_backup_dir()

    if wanted["codex"] and os.path.exists(CODEX_CONFIG):
        lines, newline = read_toml()
        clean = remove_sitegen_toml(lines, fallback=True)
        if clean != lines:
            backup(CODEX_CONFIG, backup_dir, "codex-config.toml")
            write_toml(clean, newline)
            ok("Codex settings restored.")
    if wanted["codex"] and os.path.exists(CODEX_CATALOG):
        os.remove(CODEX_CATALOG)

    claude_state = (state or {}).get("claude")
    if wanted["claude"] and claude_state and os.path.exists(CLAUDE_SETTINGS):
        try:
            settings = read_json(CLAUDE_SETTINGS, {})
            backup(CLAUDE_SETTINGS, backup_dir, "claude-settings.json")
            previous = claude_state.get("previous") or {}
            applied = claude_state.get("applied") or {}
            # Only a value that is still what the installer set is put back; a
            # value changed since then is the user's and stays.
            for name in ("apiKeyHelper", "model"):
                if settings.get(name) == applied.get(name):
                    if previous.get(name) is None:
                        settings.pop(name, None)
                    else:
                        settings[name] = previous[name]
            env = settings.get("env")
            if isinstance(env, dict):
                applied_env = applied.get("env") or {}
                previous_env = previous.get("env") or {}
                for name in CLAUDE_ENV_KEYS:
                    was, applied_value, now = previous_env.get(name), applied_env.get(name), env.get(name)
                    if applied_value is not None:
                        if now != applied_value:
                            continue
                        if was is None:
                            env.pop(name, None)
                        else:
                            env[name] = was
                    elif was is not None and now is None:
                        env[name] = was
                if not env and not previous.get("hadEnv"):
                    settings.pop("env", None)
            # A settings file the installer created, and that is empty again, goes too.
            if previous.get("fileExisted") is False and not settings:
                os.remove(CLAUDE_SETTINGS)
            else:
                write_json(CLAUDE_SETTINGS, settings)
            ok("Claude Code settings restored.")
        except (ValueError, OSError) as exc:
            warn("Could not restore %s (%s). Your backups are in %s." % (CLAUDE_SETTINGS, exc, BACKUP_ROOT))

    opencode_state = (state or {}).get("opencode")
    if wanted["opencode"] and opencode_state:
        try:
            uninstall_opencode(opencode_state, backup_dir)
            ok("OpenCode settings restored.")
        except (ValueError, OSError) as exc:
            warn("Could not restore OpenCode's settings (%s). Your backups are in %s." % (exc, BACKUP_ROOT))

    # The key stays while any tool still uses sitegen.
    keep = {name: (None if wanted[name] else (state or {}).get(name)) for name in TOOL_ORDER}
    kept = [TOOL_NAMES[t] for t in TOOL_ORDER if keep[t]]
    if kept:
        remaining = dict(state or {})
        remaining.update(keep)
        write_private(STATE_FILE, json.dumps(remaining, indent=2) + "\n")
        ok("Saved key kept: %s still use%s sitegen." % (", ".join(kept), "s" if len(kept) == 1 else ""))
    else:
        for path in (KEY_FILE, HELPER_FILE, STATE_FILE, UNDO_SCRIPT, LOCAL_COPY):
            if os.path.exists(path):
                os.remove(path)
        ok("Saved key and the undo script removed.")
    say("  Backups are kept in %s (safe to delete)." % BACKUP_ROOT)
    say(paint("32", "Done. Restart Codex, OpenCode or any open Claude Code sessions."))


def main():
    try:
        if BASE_URL.startswith("__"):
            raise SetupError("Run this from your sitegen setup page, or set SITEGEN_BASE_URL.")
        match = re.match(r"(https?)://([^/:]+)", BASE_URL)
        if not match or (match.group(1) != "https" and match.group(2) not in ("localhost", "127.0.0.1")):
            raise SetupError("The sitegen address must use https.")
        action = os.environ.get("SITEGEN_ACTION") or (DEFAULT_ACTION if not DEFAULT_ACTION.startswith("__") else "install")
        if "--uninstall" in sys.argv[1:] or action == "uninstall":
            uninstall()
        else:
            install()
    except SetupError as exc:
        say()
        say(paint("31", "  X   " + str(exc)))
        say(paint("31", "      Nothing further was changed."))
        sys.exit(1)
    except KeyboardInterrupt:
        say()
        sys.exit(130)


main()
SITEGEN_PYTHON

  # Questions need the keyboard even though this script arrived on stdin.
  status=0
  if (: </dev/tty) 2>/dev/null; then
    "$python" "$program" "$@" </dev/tty || status=$?
  else
    "$python" "$program" "$@" || status=$?
  fi
  exit "$status"
}

main "$@"
