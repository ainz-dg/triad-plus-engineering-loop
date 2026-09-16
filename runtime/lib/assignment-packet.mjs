import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeAtomicJson } from "./evidence.mjs";
import { worktreeBranch } from "./fingerprint.mjs";
import { inspectRepositoryContext } from "./repository-context.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const PACKET_START = "<!-- triad-plus-assignment-packet:start -->";
const PACKET_END = "<!-- triad-plus-assignment-packet:end -->";

function packetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function objectLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!objectLike(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function normalizeText(value) {
  return String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (objectLike(item)) {
        const pathValue = nonEmpty(item.path);
        const text = nonEmpty(item.text ?? item.excerpt ?? item.value);
        if (pathValue && text) return { path: pathValue, text };
        if (text) return text;
        return JSON.stringify(canonicalize(item));
      }
      return String(item);
    })
    .filter(Boolean);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function contextObject(assignment) {
  const context = objectLike(assignment.context) ? assignment.context : {};
  const prompt = objectLike(assignment.assignment_prompt) ? assignment.assignment_prompt : {};
  return { context, prompt };
}

function safeSlug(value, fallback = "card") {
  const slug = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function relativeProjectPath(root, value, label, { allowAbsolute = true } = {}) {
  if (typeof value !== "string" || !value.trim()) throw packetError("assignment_packet_invalid", `${label} must be a non-empty path`);
  if (!allowAbsolute && path.isAbsolute(value)) throw packetError("assignment_packet_invalid", `${label} must be project-relative`);
  const resolved = path.resolve(root, value);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    throw packetError("assignment_packet_invalid", `${label} escapes the control workspace`);
  }
  return resolved;
}

function declaredPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function assignmentRepositoryId(assignment) {
  const explicit = firstDefined(assignment.repository_id, assignment.repository, assignment.target_repository, assignment.assigned_repository);
  return typeof explicit === "string" && explicit.trim() ? explicit.trim() : null;
}

function scalarValue(value) {
  return String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

function normalizeRepositoryMappings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => objectLike(entry))
    .map((entry) => ({
      id: scalarValue(entry.id),
      path: typeof entry.path === "string" ? scalarValue(entry.path) : null,
      worktree: typeof entry.worktree === "string" ? scalarValue(entry.worktree) : null,
    }))
    .filter((entry) => entry.id && (entry.path || entry.worktree));
}

/**
 * Read only the repository mapping subset needed to authorize a declared
 * external worktree. This accepts project.yaml's stable JSON/YAML shapes and
 * is deliberately not a second general-purpose project parser.
 */
function parseRepositoryMappings(source) {
  try {
    const parsed = JSON.parse(source);
    const root = objectLike(parsed) ? parsed : {};
    const project = objectLike(root.project) ? root.project : {};
    const repositories = Array.isArray(root.repositories)
      ? root.repositories
      : Array.isArray(project.repositories) ? project.repositories : [];
    return normalizeRepositoryMappings(repositories);
  } catch {}

  const repositories = [];
  let inRepositories = false;
  let repositoryIndent = null;
  let current = null;
  let repositoryEntryIndent = null;
  let repositoryPropertyIndent = null;
  const mappingStack = [];
  const finishRepositories = () => {
    if (current) repositories.push(current);
    current = null;
    inRepositories = false;
    repositoryIndent = null;
    repositoryEntryIndent = null;
    repositoryPropertyIndent = null;
  };
  const updateMappingStack = (key, indentation) => {
    while (mappingStack.length && mappingStack[mappingStack.length - 1].indent >= indentation) mappingStack.pop();
    mappingStack.push({ key: key.toLowerCase(), indent: indentation });
  };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    const indentation = line.search(/\S/);
    const trimmed = line.trim();
    if (!trimmed || indentation < 0) continue;
    const itemMatch = line.match(/^(\s*)-\s*(?:(\w[\w-]*):\s*(.*?)\s*)?$/);
    if (inRepositories && !(itemMatch && itemMatch[1].length > repositoryIndent) && indentation <= repositoryIndent) {
      finishRepositories();
    }
    const propertyMatch = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (propertyMatch && propertyMatch[2].toLowerCase() === "repositories" && !propertyMatch[3]) {
      while (mappingStack.length && mappingStack[mappingStack.length - 1].indent >= indentation) mappingStack.pop();
      const parent = mappingStack[mappingStack.length - 1] ?? null;
      const repositoriesIndent = propertyMatch[1].length;
      const rootRepositories = repositoriesIndent === 0;
      const projectRepositories = parent?.key === "project" && parent.indent === 0;
      updateMappingStack(propertyMatch[2], repositoriesIndent);
      if (rootRepositories || projectRepositories) {
        if (inRepositories) finishRepositories();
        inRepositories = true;
        repositoryIndent = repositoriesIndent;
        repositoryEntryIndent = null;
        repositoryPropertyIndent = null;
      }
      continue;
    }
    if (itemMatch && inRepositories && itemMatch[1].length > repositoryIndent) {
      const itemIndent = itemMatch[1].length;
      if (repositoryEntryIndent !== null && itemIndent !== repositoryEntryIndent) continue;
      if (current) repositories.push(current);
      current = {};
      repositoryEntryIndent = itemIndent;
      repositoryPropertyIndent = itemMatch[2] ? itemIndent + 2 : null;
      if (itemMatch[2]) current[itemMatch[2]] = scalarValue(itemMatch[3]);
      continue;
    }
    if (inRepositories && current && propertyMatch && repositoryEntryIndent !== null) {
      const propertyIndent = propertyMatch[1].length;
      if (repositoryPropertyIndent === null) repositoryPropertyIndent = propertyIndent;
      if (propertyIndent === repositoryPropertyIndent) current[propertyMatch[2]] = scalarValue(propertyMatch[3]);
    }
    if (propertyMatch) updateMappingStack(propertyMatch[2], propertyMatch[1].length);
  }
  if (inRepositories) finishRepositories();
  return normalizeRepositoryMappings(repositories);
}

async function projectRepositoryMappings(root) {
  try {
    return parseRepositoryMappings(await readFile(path.join(root, "project.yaml"), "utf8"));
  } catch {
    return [];
  }
}

async function matchingRepositoryMappings(root, worktree) {
  const mappings = await projectRepositoryMappings(root);
  const matches = [];
  for (const mapping of mappings) {
    const declared = mapping.worktree || mapping.path;
    if (!declared) continue;
    const candidate = await realpath(declaredPath(root, declared)).catch(() => null);
    if (candidate === worktree) matches.push(mapping);
  }
  return matches;
}

async function resolveProjectRepository(root, assignment, worktree, external) {
  const explicit = assignmentRepositoryId(assignment);
  const matches = await matchingRepositoryMappings(root, worktree);
  if (external) {
    if (matches.length === 0) {
      throw packetError("assignment_packet_invalid", "assigned external worktree is not declared by a project.yaml repository mapping");
    }
    if (matches.length > 1) {
      throw packetError("assignment_packet_invalid", "assigned external worktree matches multiple project.yaml repository mappings");
    }
    if (explicit && explicit !== matches[0].id) {
      throw packetError("assignment_packet_invalid", "assigned repository does not match the project.yaml worktree mapping: " + explicit);
    }
    return matches[0].id;
  }
  if (explicit) return explicit;
  return matches.length === 1 ? matches[0].id : "declared-worktree";
}

async function repositoryMappingDetails(root, repository) {
  if (!repository) return null;
  const mapping = (await projectRepositoryMappings(root)).find((entry) => entry.id === repository);
  if (!mapping) return null;
  const declared = mapping.worktree || mapping.path;
  return {
    id: mapping.id,
    path: mapping.path,
    worktree: mapping.worktree,
    resolved_worktree: declared ? await realpath(declaredPath(root, declared)).catch(() => null) : null
  };
}

function section(source, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const lines = source.split("\n");
  const output = [];
  let active = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      const title = heading[1].replace(/[#`]/g, "").trim().toLowerCase();
      active = wanted.has(title);
      if (active) output.push(line.trimEnd());
      continue;
    }
    if (active) output.push(line.trimEnd());
  }
  return normalizeText(output.join("\n"));
}

function compactSection(source, names, fallback) {
  const value = section(source, names);
  return value || fallback;
}

function asLines(value, fallback = "Not supplied in the assignment packet context.") {
  const entries = normalizeArray(value);
  return entries.length ? entries : [fallback];
}

function renderList(title, values) {
  const lines = [`## ${title}`];
  for (const value of values) {
    if (objectLike(value)) {
      lines.push(`- ${value.path}:`);
      lines.push(`  ${normalizeText(value.text).replaceAll("\n", "\n  ")}`);
    } else {
      lines.push(`- ${normalizeText(value).replaceAll("\n", "\n  ")}`);
    }
  }
  return lines.join("\n");
}

function renderBlock(title, value, fallback = "Not supplied in the assignment packet context.") {
  const text = normalizeText(value) || fallback;
  return `## ${title}\n\n${text}`;
}

function renderContextValue(value, fallback = "Not supplied in the assignment packet context.") {
  if (typeof value === "string") return normalizeText(value) || fallback;
  const entries = asLines(value, fallback);
  return entries.map((entry) => objectLike(entry) ? `${entry.path}:\n${normalizeText(entry.text)}` : normalizeText(entry)).join("\n");
}

function packetRelativePath(root, target) {
  const relative = path.relative(root, target).replaceAll(path.sep, "/");
  return relative || ".";
}

export function defaultAssignmentPacketPath(assignment) {
  const feature = safeSlug(assignment?.feature_id);
  const attempt = Number.isInteger(assignment?.attempt) && assignment.attempt > 0
    ? String(assignment.attempt).padStart(3, "0")
    : "001";
  return `.loop/runtime/assignments/${feature}-attempt-${attempt}.md`;
}

/**
 * Resolve the operational context once, keeping control paths explicit while
 * making the product worktree the delegated agent's cwd.
 */
export async function resolveAssignmentContext(assignment, { projectRoot = process.cwd() } = {}) {
  if (!objectLike(assignment)) throw packetError("assignment_packet_invalid", "assignment must be a JSON object");
  const root = await realpath(projectRoot);
  if (assignment.project_root) {
    const declaredRoot = await realpath(declaredPath(root, assignment.project_root)).catch(() => null);
    if (declaredRoot !== root) throw packetError("assignment_packet_invalid", "assignment project root does not match control workspace");
  }
  if (!assignment.worktree || typeof assignment.worktree !== "string") {
    throw packetError("assignment_packet_invalid", "assignment worktree is required");
  }
  const declaredWorktree = declaredPath(root, assignment.worktree);
  let worktree;
  try { worktree = await realpath(declaredWorktree); }
  catch { throw packetError("assignment_packet_invalid", `assigned worktree is missing: ${assignment.worktree}`); }
  const external = !worktree.startsWith(`${root}${path.sep}`);
  const branch = await worktreeBranch(worktree);
  if (assignment.expected_branch && assignment.expected_branch !== branch) {
    throw packetError("assignment_packet_invalid", `worktree branch does not match assignment: ${branch}`);
  }
  const repository = await resolveProjectRepository(root, assignment, worktree, external);
  const repositoryMapping = await repositoryMappingDetails(root, repository);
  const requiredSkills = Array.isArray(assignment.required_repository_skills) ? assignment.required_repository_skills : [];
  let repositoryContext;
  try {
    repositoryContext = await inspectRepositoryContext({ worktree, requiredSkills });
  } catch (error) {
    error.repositoryContext = error.repositoryContext ?? null;
    throw error;
  }
  if (repositoryContext.status !== "pass") {
    const details = repositoryContext.issues.map((item) => item.message).join("; ");
    const error = packetError("repository_context_invalid", details || "assigned repository context is invalid");
    error.repositoryContext = repositoryContext;
    throw error;
  }
  return {
    projectRoot: root,
    controlWorkspace: root,
    worktree,
    cwd: worktree,
    external,
    branch,
    repository,
    repositoryMapping,
    repositoryContext,
    declaredWorktree: assignment.worktree,
    cardPath: assignment.card_path ? relativeProjectPath(root, assignment.card_path, "card path") : null,
    prdPath: assignment.prd_path ? relativeProjectPath(root, assignment.prd_path, "PRD path") : null,
    gatesPath: assignment.gates_path ? relativeProjectPath(root, assignment.gates_path, "gates path") : null,
    requiredSkills,
  };
}

function packetMetadata(assignment, context, packetPath) {
  const packetRelative = packetRelativePath(context.projectRoot, packetPath);
  return canonicalize({
    schema_version: 1,
    packet_type: "triad-assignment",
    assignment_id: assignment.assignment_id,
    feature_id: assignment.feature_id,
    attempt: assignment.attempt,
    repository: context.repository,
    repository_mapping: context.repositoryMapping,
    branch: context.branch,
    worktree: context.declaredWorktree,
    control_workspace: ".",
    cwd: context.declaredWorktree,
    card_path: assignment.card_path ?? null,
    packet_path: packetRelative,
    prd_path: assignment.prd_path ?? null,
    gates_path: assignment.gates_path ?? null,
    verification_run_id: assignment.verification_run_id ?? null,
    expected_hashes: {
      prd_sha256: assignment.expected_prd_sha256 ?? null,
      card_sha256: assignment.expected_card_sha256 ?? null,
      gates_sha256: assignment.expected_gates_sha256 ?? null,
    },
    required_gate_ids: Array.isArray(assignment.required_gate_ids) ? assignment.required_gate_ids : [],
    mandatory_skills: context.requiredSkills.map((skill) => ({ path: skill.path, sha256: skill.sha256 })),
    repository_context: {
      assigned_worktree: context.repositoryContext.assigned_worktree,
      assigned_git_top_level: context.repositoryContext.assigned_git_top_level,
      skills: context.repositoryContext.skills
    },
  });
}

/** Build a bounded, deterministic Markdown packet from an active assignment. */
export async function buildAssignmentPacket(assignment, { projectRoot = process.cwd(), packetPath = null } = {}) {
  if (assignment?.status !== "active") {
    throw packetError("assignment_packet_invalid", "assignment packet can only be created for an active assignment");
  }
  if (!Number.isInteger(assignment?.attempt) || assignment.attempt < 1) {
    throw packetError("assignment_packet_invalid", "assignment attempt must be a positive integer");
  }
  const context = await resolveAssignmentContext(assignment, { projectRoot });
  if (!assignment.assignment_id || !assignment.feature_id) {
    throw packetError("assignment_packet_invalid", "assignment ID and feature ID are required");
  }
  if (!context.cardPath) throw packetError("assignment_packet_invalid", "assignment card path is required");
  let card;
  try { card = await readFile(context.cardPath, "utf8"); }
  catch { throw packetError("assignment_packet_invalid", `feature card is missing: ${assignment.card_path}`); }
  const root = context.projectRoot;
  const target = packetPath
    ? relativeProjectPath(root, packetPath, "assignment packet path")
    : relativeProjectPath(root, assignment.assignment_packet_path ?? defaultAssignmentPacketPath(assignment), "assignment packet path");
  if (assignment.assignment_packet_path && path.resolve(root, assignment.assignment_packet_path) !== target) {
    throw packetError("assignment_packet_invalid", "requested packet path does not match the assignment binding");
  }
  const { context: supplied, prompt } = contextObject(assignment);
  const prdExcerpts = firstDefined(supplied.relevant_prd_excerpts, supplied.relevant_prd_excerpt, supplied.prd_excerpts, supplied.prd_excerpt, prompt.relevant_prd_excerpts, prompt.relevant_prd_excerpt, prompt.prd_excerpts, prompt.prd_excerpt, []);
  const adrExcerpts = firstDefined(supplied.relevant_adr_excerpts, supplied.relevant_adr_excerpt, supplied.adr_excerpts, supplied.adr_excerpt, prompt.relevant_adr_excerpts, prompt.relevant_adr_excerpt, prompt.adr_excerpts, prompt.adr_excerpt, []);
  const acceptance = firstDefined(supplied.acceptance_criteria, prompt.acceptance_criteria, prompt.requirements, []);
  const verification = firstDefined(supplied.verification_mapping, supplied.ac_mapping, supplied.verification_expectations, prompt.verification_mapping, prompt.ac_verification_mapping, prompt.verification_expectations, []);
  const expectedPaths = firstDefined(supplied.expected_paths, supplied.expected_files, supplied.touch_points, prompt.expected_paths, prompt.expected_files, prompt.touch_points, prompt.allowed_surface, prompt.scope, []);
  const constraints = firstDefined(supplied.constraints, prompt.constraints, prompt.non_goals, []);
  const risks = firstDefined(supplied.risks, prompt.risks, []);
  const previous = firstDefined(supplied.previous_evidence, supplied.prior_evidence, supplied.rework_evidence, supplied.prior_findings, supplied.previous_attempts, prompt.previous_evidence, prompt.prior_evidence, prompt.prior_findings, prompt.previous_attempts, []);
  const metadata = packetMetadata(assignment, context, target);
  const cardOutcome = compactSection(card, ["Outcome and scope"], "Card outcome/scope is available at the declared card path.");
  const cardAcceptance = compactSection(card, ["Acceptance criteria"], "Acceptance criteria are available at the declared card path.");
  const cardMetrics = compactSection(card, ["Metrics and gates"], "Metrics and gates are available at the declared card path.");
  const cardIntegration = compactSection(card, ["Integration, practical test, and risk"], "Integration details are available at the declared card path.");
  const packet = [
    PACKET_START,
    "# Triad+ Assignment Packet",
    "",
    "This immutable packet is the primary operational contract for this assignment. Read it before broad repository discovery. Consult the full PRD or ADR only for a missing detail, contradiction, or explicitly required fallback.",
    "",
    "## Packet metadata",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    renderBlock("Card outcome and scope", cardOutcome),
    "",
    renderBlock("Acceptance criteria", renderContextValue(acceptance, cardAcceptance)),
    "",
    renderBlock("Relevant PRD excerpts", renderContextValue(prdExcerpts)),
    "",
    renderBlock("Relevant ADR / architecture excerpts", renderContextValue(adrExcerpts)),
    "",
    renderBlock("AC → verification / metric mapping", renderContextValue(verification)),
    "",
    renderList("Expected files / directories / touch points", asLines(expectedPaths)),
    "",
    renderList("Known constraints", asLines(constraints)),
    "",
    renderList("Known risks", asLines(risks)),
    "",
    renderList("Mandatory repository skills", context.requiredSkills.length ? context.requiredSkills.map((skill) => `${skill.path} (sha256: ${skill.sha256})`) : ["None declared by this assignment."]),
    "",
    renderList("Previous attempt / review / rework evidence", asLines(previous, "No previous evidence is attached to this assignment.")),
    "",
    renderBlock("Card metrics and gates", cardMetrics),
    "",
    renderBlock("Integration and practical test", cardIntegration),
    "",
    "## Dispatch contract",
    "",
    `The host MUST launch this role with cwd/workdir equal to the assigned product worktree (${metadata.cwd}). Control-workspace paths remain explicit in the metadata and are not discovered by walking from the product repository. Developer and Reviewer use this same packet; Reviewer additionally receives the candidate and verifier evidence.`,
    "",
    "## Tool discipline",
    "",
    "Use native read, grep, glob, and list primitives for simple file discovery when the host provides them. Use shell/Bash for build, test, git, scripts, and system commands; do not use shell as the default filesystem API.",
    PACKET_END,
    "",
  ].join("\n");
  return { packet, packetPath: target, metadata, context, sha256: digest(packet) };
}

/** Write an immutable packet and bind its path/hash in the assignment. */
export async function writeAssignmentPacket(assignment, { projectRoot = process.cwd(), assignmentPath = null, packetPath = null } = {}) {
  const built = await buildAssignmentPacket(assignment, { projectRoot, packetPath });
  const existingPath = built.packetPath;
  let existing = null;
  try { existing = await readFile(existingPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== null && existing !== built.packet) {
    throw packetError("assignment_packet_conflict", `assignment packet already exists with different content: ${packetRelativePath(built.context.projectRoot, existingPath)}`);
  }
  if (existing === null) {
    await mkdir(path.dirname(existingPath), { recursive: true });
    try { await writeFile(existingPath, built.packet, { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const raced = await readFile(existingPath, "utf8");
      if (raced !== built.packet) throw packetError("assignment_packet_conflict", `assignment packet changed during creation: ${packetRelativePath(built.context.projectRoot, existingPath)}`);
    }
  }
  if (assignment.assignment_packet_path && path.resolve(built.context.projectRoot, assignment.assignment_packet_path) !== existingPath) {
    throw packetError("assignment_packet_invalid", "assignment packet path does not match the generated packet");
  }
  if (assignment.assignment_packet_sha256 && assignment.assignment_packet_sha256.toLowerCase() !== built.sha256) {
    throw packetError("assignment_packet_invalid", "assignment packet hash does not match generated content");
  }
  if (assignmentPath && (!assignment.assignment_packet_path || !assignment.assignment_packet_sha256)) {
    const relative = packetRelativePath(built.context.projectRoot, existingPath);
    const updated = { ...assignment, assignment_packet_path: relative, assignment_packet_sha256: built.sha256 };
    await writeAtomicJson(assignmentPath, updated);
    Object.assign(assignment, updated);
  }
  return { ...built, assignment };
}

function parseMetadata(source) {
  const start = source.indexOf(`${PACKET_START}\n`);
  const marker = "```json\n";
  const jsonStart = start < 0 ? -1 : source.indexOf(marker, start) + marker.length;
  const jsonEnd = jsonStart > marker.length ? source.indexOf("\n```", jsonStart) : -1;
  if (start < 0 || jsonStart < marker.length || jsonEnd < 0) throw packetError("assignment_packet_invalid", "assignment packet metadata is missing or malformed");
  try { return JSON.parse(source.slice(jsonStart, jsonEnd)); }
  catch { throw packetError("assignment_packet_invalid", "assignment packet metadata is not valid JSON"); }
}

/** Validate the immutable packet binding before a verifier executes gates. */
export async function validateAssignmentPacket(assignment, projectRoot = process.cwd()) {
  const pathValue = nonEmpty(assignment?.assignment_packet_path);
  const hashValue = nonEmpty(assignment?.assignment_packet_sha256);
  if (!pathValue && !hashValue) return null;
  if (!pathValue || !hashValue || !SHA256.test(hashValue)) {
    throw packetError("assignment_packet_invalid", "assignment packet requires a path and SHA-256 binding");
  }
  const root = await realpath(projectRoot);
  const target = relativeProjectPath(root, pathValue, "assignment packet path");
  let source;
  try { source = await readFile(target, "utf8"); }
  catch { throw packetError("assignment_packet_invalid", `assignment packet is missing: ${pathValue}`); }
  const actual = digest(source);
  if (actual !== hashValue.toLowerCase()) throw packetError("assignment_packet_invalid", "assignment packet hash mismatch");
  const metadata = parseMetadata(source);
  for (const [key, expected] of [["assignment_id", assignment.assignment_id], ["feature_id", assignment.feature_id], ["attempt", assignment.attempt]]) {
    if (metadata[key] !== expected) throw packetError("assignment_packet_invalid", `assignment packet ${key} does not match assignment`);
  }
  if (assignment.expected_branch && metadata.branch !== assignment.expected_branch) throw packetError("assignment_packet_invalid", "assignment packet branch does not match assignment");
  if (metadata.packet_path !== packetRelativePath(root, target)) throw packetError("assignment_packet_invalid", "assignment packet metadata path does not match its location");
  return { path: packetRelativePath(root, target), sha256: actual, metadata };
}

export { PACKET_END, PACKET_START };
