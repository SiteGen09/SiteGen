#!/bin/sh
# sitegen setup for Codex and Claude Code on macOS and Linux.
#
#   Install:    curl -fsSL __SITEGEN_BASE_URL__/install.sh | sh
#   Undo:       curl -fsSL __SITEGEN_BASE_URL__/uninstall.sh | sh
#               (or, offline: sh ~/.sitegen/uninstall.sh)
#
# Points Codex (CLI, desktop app, IDE extension) and Claude Code (CLI, IDE
# extensions) at your sitegen account, each with its own model family: GPT
# models for Codex, Claude models for Claude Code.
#
# Your API key is stored in ~/.sitegen/api-key, readable only by you. The Codex
# and Claude Code settings only name a small helper script that prints it; the
# key itself is never written into them. Every file this changes is backed up
# to ~/.sitegen/backups first, and --uninstall puts your previous settings back.
#
# Needs curl and Python 3 (on macOS, Apple's command line tools provide it).
#
# Optional environment variables:
#   SITEGEN_TOOLS         codex, claude or both (skips the question); undo
#                         reverts only the named tool when it is set
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
import datetime, getpass, json, os, re, shlex, shutil, stat, subprocess, sys, tempfile

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
                   "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]

COLOR = sys.stdout.isatty()


class SetupError(Exception):
    pass


def paint(code, text):
    return "\033[%sm%s\033[0m" % (code, text) if COLOR else text


def say(text=""):
    print(text, flush=True)


def step(text):
    say()
    say(paint("36", text))


def ok(text):
    say(paint("32", "  OK  " + text))


def warn(text):
    say(paint("33", "  !   " + text))


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


def codex_catalog(bundled, ids):
    """One catalog entry per sitegen GPT model, cloned from the closest
    built-in model so Codex keeps its own instructions, then limited to what
    sitegen's Responses endpoint serves: plain function tools, text input, no
    hosted search, no priority tier, no "responses lite" or code-mode tools."""
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
            "input_modalities": ["text"],
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

    helper = "/bin/sh " + shlex.quote(HELPER_FILE)
    applied_env = {
        "ANTHROPIC_BASE_URL": BASE_URL,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": tiers["opus"],
        "ANTHROPIC_DEFAULT_SONNET_MODEL": tiers["sonnet"],
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": tiers["haiku"],
        "ANTHROPIC_SMALL_FAST_MODEL": tiers["haiku"],
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
    if kind == "codex":
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
    """SITEGEN_TOOLS as a set: codex, claude, or both when unset or 'both'."""
    raw = (os.environ.get("SITEGEN_TOOLS") or "both").lower()
    codex = "codex" in raw or "both" in raw or "all" in raw
    claude = "claude" in raw or "both" in raw or "all" in raw
    if not codex and not claude:
        raise SetupError("SITEGEN_TOOLS must be codex, claude or both (it is '%s')." % os.environ.get("SITEGEN_TOOLS"))
    return {"codex": codex, "claude": claude, "explicit": bool(os.environ.get("SITEGEN_TOOLS"))}


def select_tools(can_codex, can_claude):
    wanted = tools_filter()
    pick = {"codex": can_codex and wanted["codex"], "claude": can_claude and wanted["claude"]}
    if wanted["explicit"] or not (can_codex and can_claude) or not interactive():
        return pick
    say()
    say("  What should sitegen set up?")
    say("     1. Codex and Claude Code  (recommended)")
    say("     2. Only Codex             (Claude Code stays as it is)")
    say("     3. Only Claude Code       (Codex stays as it is)")
    while True:
        answer = input("  Press Enter for 1, or type a number: ").strip()
        if answer in ("", "1"):
            return {"codex": True, "claude": True}
        if answer == "2":
            return {"codex": True, "claude": False}
        if answer == "3":
            return {"codex": False, "claude": True}
        warn("Type 1, 2 or 3.")


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
    say(paint("1", "sitegen setup for Codex and Claude Code"))
    say("Server: " + BASE_URL)

    step("1. Your sitegen API key")
    key = read_api_key()
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
    ok("Key accepted: %d GPT models for Codex, %d Claude models for Claude Code." % (len(gpt), len(claude)))

    step("2. Looking for Codex and Claude Code")
    codex = find_codex()
    claude_exe = find_claude()
    if codex:
        ok("Codex found: " + codex)
    else:
        warn("Codex was not found. Install it first (npm i -g @openai/codex, or the Codex app), then run this again to set it up.")
    if claude_exe:
        ok("Claude Code found: " + claude_exe)
    else:
        warn("Claude Code was not found. Its settings will still be written, ready for when you install it "
             "(curl -fsSL https://claude.ai/install.sh | bash).")
    if codex and not gpt:
        warn("Your plan has no GPT models, so Codex was left unchanged.")
    if not claude:
        warn("Your plan has no Claude models, so Claude Code was left unchanged.")
    tools = select_tools(bool(codex) and bool(gpt), bool(claude))
    do_codex, do_claude = tools["codex"], tools["claude"]
    if not do_codex and not do_claude:
        raise SetupError("Nothing to set up.")

    codex_model = claude_model = tiers = None
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
                 "claude": None if do_claude else (state or {}).get("claude")}

    step("4. Setting up the apps")
    if do_codex and install_codex(codex, gpt, codex_model, backup_dir):
        new_state["codex"] = {"home": CODEX_HOME, "config": CODEX_CONFIG, "catalog": CODEX_CATALOG, "model": codex_model}
        ok("Codex now uses sitegen (%s by default, %d models in its picker)." % (codex_model, len(gpt)))
    if do_claude:
        result = install_claude(claude_model, tiers, state, backup_dir)
        if result is not None:
            new_state["claude"] = result
            ok("Claude Code now uses sitegen (%s by default; opus=%s, sonnet=%s, haiku=%s)."
               % (claude_model, tiers["opus"], tiers["sonnet"], tiers["haiku"]))
    write_private(STATE_FILE, json.dumps(new_state, indent=2) + "\n")
    say("  Backups of your previous settings: " + backup_dir)
    undo_script = install_undo_script()

    if not os.environ.get("SITEGEN_SKIP_TEST"):
        step("5. Sending one short test message")
        if do_codex and new_state["codex"]:
            err = test_route(key, "codex", codex_model)
            if err:
                warn("Codex route test failed: " + err)
            else:
                ok("Codex route answered (%s)." % codex_model)
        if do_claude and new_state["claude"]:
            err = test_route(key, "claude", claude_model)
            if err:
                warn("Claude Code route test failed: " + err)
            else:
                ok("Claude Code route answered (%s)." % claude_model)

    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"):
        if os.environ.get(name):
            warn("%s is set in your shell (check ~/.zshrc, ~/.bashrc or ~/.profile) and may override these settings. "
                 "Remove it if Claude Code does not use sitegen." % name)

    say()
    say(paint("32", "Done."))
    for name, done, label, hint in (
            ("codex", do_codex, "Codex:       ", "restart the Codex app if it is open, or run: codex"),
            ("claude", do_claude, "Claude Code: ", "open a new terminal and run: claude  (IDE extensions pick it up on restart)")):
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
    names = " and ".join(n for n, on in (("Codex", wanted["codex"]), ("Claude Code", wanted["claude"])) if on)
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

    # The key stays while either tool still uses sitegen.
    keep = {name: (None if wanted[name] else (state or {}).get(name)) for name in ("codex", "claude")}
    if keep["codex"] or keep["claude"]:
        remaining = dict(state or {})
        remaining.update(keep)
        write_private(STATE_FILE, json.dumps(remaining, indent=2) + "\n")
        ok("Saved key kept: %s still uses sitegen." % ("Codex" if keep["codex"] else "Claude Code"))
    else:
        for path in (KEY_FILE, HELPER_FILE, STATE_FILE, UNDO_SCRIPT, LOCAL_COPY):
            if os.path.exists(path):
                os.remove(path)
        ok("Saved key and the undo script removed.")
    say("  Backups are kept in %s (safe to delete)." % BACKUP_ROOT)
    say(paint("32", "Done. Restart the Codex app or any open Claude Code sessions."))


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
