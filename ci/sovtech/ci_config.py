#!/usr/bin/env -S python3 -I
"""Static runner-routing check for .gitlab-ci.yml (Python 3 standard library only).

The runner split (ci-sovgit takes unprotected refs, ci-sovgit-prot protected
ones) holds only if every job's tag comes from ref protection. GitLab gives a
runner any job whose tags it has, and the unprotected runner also takes jobs
on protected refs, so one job tagged with the unprotected tag on main would
run beside main's protected state. This check proves, from the file alone:

  - the file is in the strict YAML subset below; anything else fails;
  - workflow:rules: the last rule is "when: never", and every other rule is
    an "if" that is a plain conjunction of simple comparisons (no ||, no
    parentheses) and sets variables: SOVGIT_RUNNER_TAG and nothing else. It
    is the protected tag exactly when the rule requires
    $CI_COMMIT_REF_PROTECTED == "true" and the unprotected tag exactly when
    it requires $CI_COMMIT_REF_PROTECTED != "true"; one of the two is
    required, once;
  - a protected rule pins $CI_COMMIT_BRANCH == "main" or $CI_COMMIT_TAG =~
    /^sovtech-v/ (neither variable exists in a merge request pipeline) and
    tests $CI_PIPELINE_SOURCE, if at all, only as == "push": merge request
    and schedule rules can only be unprotected;
  - the only tags key is default:tags, exactly [$SOVGIT_RUNNER_TAG]; no job
    or template has tags or inherit;
  - no include, trigger, inherit, parallel or dotenv key anywhere (a
    parallel:matrix entry sets job variables that tags expand);
  - no other variables block (top level, job, template or job rule) sets
    SOVGIT_RUNNER_TAG, and none, workflow rules included, sets any CI_* key;
  - the two tag literals appear on no other line, comments included.

Positive controls run first: mutated copies of the file (a job tagged with
the unprotected tag, a changed default tag, SOVGIT_RUNNER_TAG set by a job, a
job rule or a job matrix, a CI_* variable, an include, an inherit, a flipped
protection test, a protected merge request, schedule or unpinned rule, a rule
without variables, a missing final "when: never", an anchor) must each fail
on the rule they target.

The YAML subset (what prettier writes for this file, and nothing else):
block mappings and sequences indented with spaces; keys matching KEY; plain
scalars on one line that start with a letter, digit, "_", "$", "." or "/";
double-quoted scalars without backslashes or "#"; one-line flow sequences of
simple items; "#" comments after a space. Refused: anchors, aliases, tags,
flow mappings, block scalars, multi-line scalars, merge keys, quoted or
complex keys, duplicate keys, documents and directives, tabs, CR, non-ASCII.

Usage: ci_config.py --file PATH
Exit codes: see sovci.py.
"""

import sys

# Isolated mode keeps the script's directory and the working directory off
# sys.path, so a file there cannot stand in for a standard-library module.
# The guard comes before every other import, __future__ included: sys is
# built in, but without -I the next import could already be a planted
# sibling such as argparse.py. Python 3.10 or later: the annotations below
# use X | None, evaluated when each function is defined.
if not sys.flags.isolated or sys.version_info < (3, 10):
    sys.stderr.write("ERROR: run this script with python3 -I (Python 3.10 or later)\n")
    sys.exit(4)
sys.dont_write_bytecode = True  # -I ignores PYTHONDONTWRITEBYTECODE

import argparse
import os
import re
import types


def _load_sibling(name: str):
    """Load ci/sovtech/<name>.py from its source: read the .py file, compile
    it here and run it in a fresh module. No import machinery is involved, so
    no .pyc is ever read (a planted __pycache__ entry, unchecked-hash ones
    included, cannot stand in for the source), and the directory never joins
    sys.path, so no file in it can shadow a standard-library module."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name + ".py")
    with open(path, "rb") as handle:
        source = handle.read()
    module = types.ModuleType("sovtech_" + name)
    module.__file__ = path
    exec(compile(source, path, "exec", dont_inherit=True), module.__dict__)
    return module


sovci = _load_sibling("sovci")
CIError = sovci.CIError

TAG_VAR = "SOVGIT_RUNNER_TAG"
TAG_PROT, TAG_OPEN = "sovgit-prot", "sovgit"
PROTECTED_TRUE = '$CI_COMMIT_REF_PROTECTED == "true"'
PROTECTED_NOT_TRUE = '$CI_COMMIT_REF_PROTECTED != "true"'
# parallel:matrix sets job variables that tags expand, so a matrix entry could
# pick a job's runner past every variables-block check below.
FORBIDDEN_KEYS = ("include", "trigger", "inherit", "dotenv", "parallel")
# A protected rule must pin one of these refs; neither variable is set in a
# merge request pipeline, so no protected rule can match one.
PROTECTED_PINS = ('$CI_COMMIT_BRANCH == "main"', "$CI_COMMIT_TAG =~ /^sovtech-v/")
# The only pipeline-source test a protected rule may carry. Merge requests
# (an untrusted head) and schedules (drift stays beside no protected state)
# must never reach the protected runner, in any spelling of the test.
PUSH_SOURCE = '$CI_PIPELINE_SOURCE == "push"'

KEY = re.compile(r"[A-Za-z0-9_.][A-Za-z0-9_.-]*(?::[A-Za-z0-9_.-]+)*")
PLAIN_START = re.compile(r"[A-Za-z0-9_$./]")
FLOW_ITEM = re.compile(r'[A-Za-z0-9_.$/][A-Za-z0-9_.$/-]*|"[A-Za-z0-9_.$/ -]*"')
# One conjunct of a workflow "if": $VAR == "literal", $VAR != "literal" or
# $VAR =~ /regex/. No spaces inside a regex, so one cannot span a " && ".
CONJUNCT = re.compile(
    r'\$[A-Z][A-Z0-9_]*(?: (?:==|!=) "[A-Za-z0-9_./-]*"| =~ /(?:[A-Za-z0-9_.^$-]|\\/)+/)'
)
# Raw-line scans, comments included, independent of the parser.
TAG_LITERAL = re.compile(r"(?i)(?<![A-Za-z0-9_-])sovgit(?:-prot)?(?![A-Za-z0-9_-])")
FORBIDDEN_RAW = re.compile(r"(?i)(?<![A-Za-z0-9_-])(include|trigger|inherit|dotenv|parallel)[\"']?\s*:")
TAGS_RAW = re.compile(r"(?i)(?<![A-Za-z0-9_$-])tags[\"']?\s*:")
GLOBAL_KEYS = ("workflow", "variables", "stages", "default", "include")


class Unsupported(Exception):
    """The file leaves the YAML subset this check can read exactly."""

    def __init__(self, number: int, why: str) -> None:
        super().__init__("line %d: %s" % (number, why))


# --- the YAML subset ---


def strip_comment(text: str, number: int) -> str:
    quoted = False
    for i, ch in enumerate(text):
        if ch == '"':
            quoted = not quoted
        elif quoted and ch in "\\#":
            raise Unsupported(number, "backslash or # inside double quotes")
        elif ch == "#" and not quoted:
            if i == 0 or text[i - 1] != " ":
                raise Unsupported(number, "# that does not start a comment")
            return text[:i].rstrip(" ")
    if quoted:
        raise Unsupported(number, "unbalanced double quote")
    return text.rstrip(" ")


def logical_lines(text: str) -> list:
    for ch in text:
        if not (ch == "\n" or 0x20 <= ord(ch) < 0x7F):
            raise Unsupported(0, "tab, CR, control or non-ASCII character")
    out = []
    for number, raw in enumerate(text.split("\n"), start=1):
        body = raw.lstrip(" ")
        if not body or body.startswith("#"):
            continue
        body = strip_comment(body, number)
        if body.startswith(("---", "...", "%")):
            raise Unsupported(number, "document marker or directive")
        out.append((number, len(raw) - len(raw.lstrip(" ")), body))
    return out


def indicator(text: str) -> int | None:
    """Position of the first ": " or of a final ":" (the mapping indicator)."""
    for i, ch in enumerate(text):
        if ch == ":" and (i + 1 == len(text) or text[i + 1] == " "):
            return i
    return None


def is_item(body: str) -> bool:
    return body == "-" or body.startswith("- ")


def inline_value(text: str, number: int):
    if text.startswith("["):
        if not text.endswith("]"):
            raise Unsupported(number, "flow sequence not closed on its line")
        inner = text[1:-1].strip(" ")
        items = [] if not inner else [part.strip(" ") for part in inner.split(",")]
        for item in items:
            if not FLOW_ITEM.fullmatch(item):
                raise Unsupported(number, "flow sequence item outside the subset")
        return [(number, item.strip('"')) for item in items]
    if text.startswith('"'):
        if len(text) < 2 or not text.endswith('"') or '"' in text[1:-1]:
            raise Unsupported(number, "double-quoted scalar outside the subset")
        return text[1:-1]
    if not PLAIN_START.match(text):
        raise Unsupported(number, "scalar starts with a YAML indicator")
    if indicator(text) is not None:
        raise Unsupported(number, "': ' inside a plain scalar")
    return text


class Parser:
    def __init__(self, lines: list) -> None:
        self.lines, self.i = lines, 0

    def peek(self):
        return self.lines[self.i] if self.i < len(self.lines) else None

    def no_deeper(self, indent: int) -> None:
        nxt = self.peek()
        if nxt is not None and nxt[1] > indent:
            raise Unsupported(nxt[0], "continuation line or block under a scalar")

    def nested(self, indent: int, number: int):
        nxt = self.peek()
        if nxt is None or nxt[1] <= indent:
            raise Unsupported(number, "empty value")
        return self.block(nxt[1])

    def block(self, indent: int):
        number, ind, body = self.peek()
        if ind != indent:
            raise Unsupported(number, "unexpected indentation")
        if is_item(body):
            return self.sequence(indent)
        return self.mapping(indent)

    def mapping(self, indent: int, first=None) -> dict:
        result = {}
        while True:
            if first is not None:
                number, body = first
                first = None
            else:
                line = self.peek()
                if line is None or line[1] < indent:
                    break
                number, ind, body = line
                if ind > indent:
                    raise Unsupported(number, "unexpected indentation")
                if is_item(body):
                    raise Unsupported(number, "sequence item where a key belongs")
                self.i += 1
            pos = indicator(body)
            if pos is None or not KEY.fullmatch(body[:pos]):
                raise Unsupported(number, "not a simple 'key: value' line")
            key, rest = body[:pos], body[pos + 1 :].lstrip(" ")
            if key in result:
                raise Unsupported(number, "duplicate key %s" % key)
            if rest:
                result[key] = (number, inline_value(rest, number))
                self.no_deeper(indent)
            else:
                result[key] = (number, self.nested(indent, number))
        return result

    def sequence(self, indent: int) -> list:
        items = []
        while True:
            line = self.peek()
            if line is None or line[1] < indent or not is_item(line[2]):
                break
            number, ind, body = line
            if ind > indent:
                raise Unsupported(number, "unexpected indentation")
            self.i += 1
            if body == "-":
                items.append((number, self.nested(indent, number)))
                continue
            rest = body[2:]
            if rest.startswith(" ") or is_item(rest):
                raise Unsupported(number, "sequence item outside the subset")
            if not rest.startswith('"') and indicator(rest) is not None:
                items.append((number, self.mapping(indent + 2, first=(number, rest))))
            else:
                items.append((number, inline_value(rest, number)))
                self.no_deeper(indent)
        return items


def parse(text: str) -> dict:
    lines = logical_lines(text)
    if not lines:
        raise Unsupported(0, "empty file")
    parser = Parser(lines)
    if lines[0][1] != 0:
        raise Unsupported(lines[0][0], "the document must start at column 0")
    tree = parser.mapping(0)
    if parser.peek() is not None:
        raise Unsupported(parser.peek()[0], "unexpected indentation")
    return tree


def walk(node, path=()):
    """(path, key, line, value) for every mapping entry, depth first."""
    if isinstance(node, dict):
        for key, (number, value) in node.items():
            yield path, key, number, value
            yield from walk(value, path + (key,))
    elif isinstance(node, list):
        for index, (_, value) in enumerate(node):
            yield from walk(value, path + (index,))


# --- the checks ---


def check(text: str) -> list:
    """(rule, line, detail) findings; empty when the file routes correctly."""
    try:
        tree = parse(text)
    except Unsupported as exc:
        return [("unsupported-yaml", 0, str(exc))]
    findings = []
    tag_lines = set()

    def fail(rule: str, number: int, detail: str) -> None:
        findings.append((rule, number, detail))

    # workflow:rules, the only place SOVGIT_RUNNER_TAG is set.
    workflow = tree.get("workflow", (0, None))[1]
    rules = workflow.get("rules", (0, None))[1] if isinstance(workflow, dict) else None
    if not isinstance(workflow, dict) or set(workflow) != {"rules"} or not isinstance(rules, list):
        fail("workflow", 0, "workflow must hold only a rules list")
        rules = []
    for index, (number, rule) in enumerate(rules):
        last = index == len(rules) - 1
        if not isinstance(rule, dict):
            fail("workflow", number, "a rule is not a mapping")
            continue
        if set(rule) == {"when"}:
            if not last or rule["when"][1] != "never":
                fail("workflow", number, "only a final 'when: never' may stand without an if")
            continue
        if set(rule) != {"if", "variables"}:
            fail("workflow", number, "a rule must hold exactly if and variables")
            continue
        cond, variables = rule["if"][1], rule["variables"][1]
        if not isinstance(cond, str) or not isinstance(variables, dict):
            fail("workflow", number, "if must be a string and variables a mapping")
            continue
        parts = cond.split(" && ")
        if any(not CONJUNCT.fullmatch(part) for part in parts):
            fail("workflow", number, "if is not a plain conjunction of simple comparisons")
            continue
        protected = [part for part in parts if part.startswith("$CI_COMMIT_REF_PROTECTED ")]
        if protected == [PROTECTED_TRUE]:
            want = TAG_PROT
            if not any(part in PROTECTED_PINS for part in parts):
                fail("workflow-context", number,
                     'a protected rule must pin $CI_COMMIT_BRANCH == "main" or a sovtech-v tag')
            sources = [part for part in parts if part.startswith("$CI_PIPELINE_SOURCE ")]
            if any(part != PUSH_SOURCE for part in sources):
                fail("workflow-context", number,
                     'a protected rule may test $CI_PIPELINE_SOURCE only as == "push"')
        elif protected == [PROTECTED_NOT_TRUE]:
            want = TAG_OPEN
        else:
            fail("workflow", number, "if must test $CI_COMMIT_REF_PROTECTED exactly once, against \"true\"")
            continue
        value = variables.get(TAG_VAR, (0, None))
        if set(variables) != {TAG_VAR} or value[1] != want:
            fail("workflow", number, "this rule must set only %s, to %s" % (TAG_VAR, want))
            continue
        tag_lines.add(value[0])
    if not rules or not isinstance(rules[-1][1], dict) or rules[-1][1].get("when", (0, None))[1] != "never":
        fail("workflow", 0, "the last workflow rule must be 'when: never'")

    tags_found = 0
    for path, key, number, value in walk(tree):
        if key in FORBIDDEN_KEYS:
            fail("forbidden-key", number, "%s is not allowed" % key)
        if key == "tags":
            tags_found += 1
            items = [item for _, item in value] if isinstance(value, list) else None
            if path != ("default",) or items != ["$" + TAG_VAR]:
                fail("tags", number, "the only tags key is default:tags, exactly [$%s]" % TAG_VAR)
        if key == "variables":
            in_workflow = len(path) == 3 and path[:2] == ("workflow", "rules")
            if not isinstance(value, dict):
                fail("variables", number, "variables must be a mapping")
                continue
            for name, (line, _) in value.items():
                if in_workflow:
                    continue  # checked with the rules above
                if name == TAG_VAR:
                    fail("variables", line, "%s may be set only by workflow:rules" % name)
                elif name.startswith("CI_"):
                    fail("variables", line, "%s: no variables block may set a CI_* key" % name)
    if tags_found != 1:
        fail("tags", 0, "default:tags must be the one and only tags key (found %d)" % tags_found)

    tag_raw = []
    for number, raw in enumerate(text.split("\n"), start=1):
        if TAG_LITERAL.search(raw) and number not in tag_lines:
            fail("literal", number, "a runner tag literal outside the workflow variables")
        if FORBIDDEN_RAW.search(raw):
            fail("forbidden-key", number, "include, trigger, inherit, dotenv or parallel (raw scan)")
        if TAGS_RAW.search(raw):
            tag_raw.append(number)
    default_tags = tree.get("default", (0, {}))[1]
    default_line = default_tags.get("tags", (0, None))[0] if isinstance(default_tags, dict) else 0
    if tag_raw != [default_line]:
        fail("tags", 0, "raw scan: a tags key outside default:tags (lines %s)" % tag_raw)
    return findings


# --- positive controls ---


def first_job_line(lines: list) -> int:
    rx = re.compile(r"([A-Za-z0-9][A-Za-z0-9_.-]*(?::[A-Za-z0-9_.-]+)*):")
    for index, line in enumerate(lines):
        match = rx.fullmatch(line)
        if match and match.group(1) not in GLOBAL_KEYS:
            return index
    raise CIError("control: no job found to mutate")


def mutations(text: str) -> list:
    lines = text.split("\n")
    job = first_job_line(lines)
    never = [i for i, line in enumerate(lines) if line == "    - when: never"]
    if len(never) != 1:
        raise CIError("control: no single final '    - when: never' line")
    default_tags = "  tags: [$%s]" % TAG_VAR
    if lines.count(default_tags) != 1:
        raise CIError("control: no single default tags line")

    def insert(extra: list) -> str:
        return "\n".join(lines[: job + 1] + extra + lines[job + 1 :])

    def append(extra: list) -> str:
        return text.rstrip("\n") + "\n\n" + "\n".join(extra) + "\n"

    def rule(cond: str, tag: str | None) -> str:
        extra = ["    - if: " + cond]
        if tag is not None:
            extra += ["      variables:", "        %s: %s" % (TAG_VAR, tag)]
        return "\n".join(lines[: never[0]] + extra + lines[never[0] :])

    prot = [i for i, line in enumerate(lines)
            if line.startswith("    - if: ") and PROTECTED_TRUE in line]
    if not prot:
        raise CIError("control: no protected workflow rule to flip")
    flipped = "\n".join(lines[: prot[0]]
                         + [lines[prot[0]].replace(PROTECTED_TRUE, PROTECTED_NOT_TRUE)]
                         + lines[prot[0] + 1 :])
    mr, sched = '$CI_PIPELINE_SOURCE == "merge_request_event"', '$CI_PIPELINE_SOURCE =~ /^schedule$/'
    on_main = PROTECTED_PINS[0]
    return [
        ("job-tagged-unprotected", insert(["  tags: [%s]" % TAG_OPEN]), "tags"),
        ("default-tag-changed",
         text.replace(default_tags, "  tags: [%s]" % TAG_OPEN, 1), "tags"),
        ("job-sets-tag-variable",
         append(["control:job:", "  variables:", "    %s: $CI_JOB_NAME" % TAG_VAR]), "variables"),
        ("job-rule-sets-tag-variable",
         append(["control:job:", "  rules:", '    - if: $CI_PIPELINE_SOURCE == "push"',
                 "      variables:", "        %s: $CI_JOB_NAME" % TAG_VAR]), "variables"),
        ("job-sets-ci-variable",
         append(["control:job:", "  variables:", '    CI_COMMIT_REF_PROTECTED: "true"']), "variables"),
        ("include", append(["include:", "  - local: other.yml"]), "forbidden-key"),
        ("job-inherit", insert(["  inherit:", "    default: false"]), "forbidden-key"),
        ("job-matrix",
         insert(["  parallel:", "    matrix:", "      - %s: [%s]" % (TAG_VAR, TAG_OPEN)]), "forbidden-key"),
        ("flipped-protection", flipped, "workflow"),
        ("protected-mr-rule",
         rule("%s && %s && %s" % (mr, on_main, PROTECTED_TRUE), TAG_PROT), "workflow-context"),
        ("protected-schedule-rule",
         rule("%s && %s && %s" % (sched, on_main, PROTECTED_TRUE), TAG_PROT), "workflow-context"),
        ("unpinned-protected-rule",
         rule('$CI_COMMIT_REF_NAME == "main" && %s' % PROTECTED_TRUE, TAG_PROT), "workflow-context"),
        ("rule-without-variables", rule('$CI_PIPELINE_SOURCE == "web"', None), "workflow"),
        ("no-final-never", "\n".join(lines[: never[0]] + lines[never[0] + 1 :]), "workflow"),
        ("anchor", insert(["  timeout: &x 1h"]), "unsupported-yaml"),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--file", required=True, help="a copy of .gitlab-ci.yml")
    args = parser.parse_args()
    try:
        with open(args.file, "rb") as handle:
            raw = handle.read()
        try:
            text = raw.decode("ascii")
        except UnicodeDecodeError:
            text = raw.decode("utf-8", "surrogateescape")
        for name, mutated, rule in mutations(text):
            hits = [f for f in check(mutated) if f[0] == rule]
            if not hits:
                raise CIError("positive control %s: the mutated copy passed rule %s" % (name, rule))
            print("ok   ci-config-control: %s fails on %s" % (name, rule))
        findings = check(text)
    except (CIError, OSError) as exc:
        print("ERROR ci-config: %s" % sovci.safe(str(exc)))
        return sovci.EXIT_ERROR
    for rule, number, detail in findings:
        print("FAIL ci-config %s: line %d: %s" % (rule, number, sovci.safe(detail)))
    if findings:
        return sovci.EXIT_FINDINGS
    print("ok   ci-config: every job's runner tag comes from ref protection")
    return sovci.EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
