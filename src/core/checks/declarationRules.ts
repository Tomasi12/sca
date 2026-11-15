// Coding rules, batch 4: declarations.
//
//   sca-own:unused-variable      a local variable that is never used
//   sca-own:unused-parameter     a parameter that is never used (write (void)p; if that is intended)
//   sca-own:shadowing            a local hides a parameter, an outer local or a global with the same name
//   sca-own:missing-volatile     a file-level object shared by an interrupt handler and other code, not volatile
//   sca-own:internal-linkage     a file-level function or object that no header declares, but is not static
//   sca-own:dynamic-memory       malloc / calloc / realloc / free (and new / delete)
//   sca-own:magic-number         an unnamed numeric constant in code (off by default)
//   sca-own:empty-parameter-list a C function declared with () instead of (void)

import { Node } from "web-tree-sitter";
import { SourceContext } from "../analyzer";
import { functionName } from "../engine/cfg";
import { Finding } from "../finding";
import { languageForFile } from "../parser/parser";
import {
  codeOnly,
  declaredName,
  functionDeclarator,
  functionsOf,
  hasQualifier,
  hasStorage,
  nodesOf,
  nodesWithin,
  originalText,
  parameterNames,
  ruleFinding,
  wordCount,
} from "./ruleKit";

export const UNUSED_VARIABLE_RULE = "sca-own:unused-variable";
export const UNUSED_PARAMETER_RULE = "sca-own:unused-parameter";
export const SHADOWING_RULE = "sca-own:shadowing";
export const MISSING_VOLATILE_RULE = "sca-own:missing-volatile";
export const INTERNAL_LINKAGE_RULE = "sca-own:internal-linkage";
export const DYNAMIC_MEMORY_RULE = "sca-own:dynamic-memory";
export const MAGIC_NUMBER_RULE = "sca-own:magic-number";
export const EMPTY_PARAMETER_LIST_RULE = "sca-own:empty-parameter-list";

export const DECLARATION_RULES = [
  UNUSED_VARIABLE_RULE,
  UNUSED_PARAMETER_RULE,
  SHADOWING_RULE,
  MISSING_VOLATILE_RULE,
  INTERNAL_LINKAGE_RULE,
  DYNAMIC_MEMORY_RULE,
  MAGIC_NUMBER_RULE,
  EMPTY_PARAMETER_LIST_RULE,
];

const HEAP_FUNCTIONS = new Set(["malloc", "calloc", "realloc", "free", "aligned_alloc", "strdup", "strndup", "valloc", "pvPortMalloc", "vPortFree"]);
/** Names that mark an interrupt handler: sched_tick_isr, TIM2_IRQHandler, can_rx_interrupt. */
const ISR_NAME = /(^|_)(isr|irq)(_|$)|(^|_)interrupt(_|$)/i;
/** CMSIS-style handler names, case-sensitive: TIM2_IRQHandler, SysTick_Handler (not can_register_handler). */
const HANDLER_NAME = /IRQHandler$|[A-Za-z0-9]_Handler$/;
/** Numbers that are not "magic": 0, 1 and their float forms. */
const PLAIN_NUMBERS = new Set([0, 1]);

export function checkDeclarations(source: SourceContext): Finding[] {
  if (!source.parsed) {
    return [];
  }
  const out: Finding[] = [];
  const fileObjects = fileLevelObjects(source);
  for (const fn of functionsOf(source)) {
    unused(source, fn, out);
    shadowing(source, fn, fileObjects, out);
  }
  missingVolatile(source, fileObjects, out);
  internalLinkage(source, out);
  for (const n of nodesOf(source, "call_expression", "new_expression", "delete_expression")) {
    const name = n.type === "call_expression" ? n.childForFieldName("function")?.text : n.type === "new_expression" ? "new" : "delete";
    if (name && (HEAP_FUNCTIONS.has(name) || n.type !== "call_expression")) {
      out.push(ruleFinding(source, DYNAMIC_MEMORY_RULE, n, `${name}${n.type === "call_expression" ? "()" : ""} uses heap memory; in embedded code allocate statically so memory use is known at build time.`));
    }
  }
  for (const n of nodesOf(source, "number_literal")) {
    magicNumber(source, n, out);
  }
  if (languageForFile(source.file) === "c") {
    for (const d of nodesOf(source, "function_declarator")) {
      const params = d.childForFieldName("parameters");
      if (params && params.namedChildren.filter((c) => c?.type !== "comment").length === 0 && !params.text.includes("void") && d.parent?.type !== "pointer_declarator" && !isCall(d)) {
        out.push(ruleFinding(source, EMPTY_PARAMETER_LIST_RULE, d, `${d.childForFieldName("declarator")?.text ?? "The function"}() has an empty parameter list, which in C means "any arguments"; write (void).`));
      }
    }
  }
  return out;
}

/** A function_declarator that tree-sitter made from what is really a macro call at file level. */
function isCall(d: Node): boolean {
  return d.parent?.type === "ERROR";
}

// ---------------------------------------------------------------------------------------------------------

function unused(source: SourceContext, fn: Node, out: Finding[]): void {
  const body = fn.childForFieldName("body");
  if (!body) {
    return;
  }
  // Count in the text as written (inactive #if branches included), without comments and strings.
  const bodyText = codeOnly(originalText(source, body.startPosition, body.endPosition));
  for (const p of parameterNames(fn)) {
    if (wordCount(bodyText, p.text) === 0) {
      out.push(ruleFinding(source, UNUSED_PARAMETER_RULE, p, `Parameter ${p.text} is never used; remove it, or write (void)${p.text}; if the interface requires it.`));
    }
  }
  for (const decl of nodesWithin(source, body, "declaration")) {
    if (hasStorage(decl, "extern")) {
      continue;
    }
    for (const d of decl.childrenForFieldName("declarator")) {
      const id = declaredName(d);
      if (!id || d?.type === "function_declarator") {
        continue;
      }
      // Uses after the declaration (its own initializer does not count).
      const after = codeOnly(originalText(source, decl.endPosition, body.endPosition));
      if (wordCount(after, id.text) === 0 && !laterDeclaratorsUse(decl, d, id.text)) {
        out.push(ruleFinding(source, UNUSED_VARIABLE_RULE, id, `Local variable ${id.text} is never used; remove it.`));
      }
    }
  }
}

/** `int a = 0, b = a;` uses a in a later declarator of the same declaration. */
function laterDeclaratorsUse(decl: Node, d: Node | null, name: string): boolean {
  const list = decl.childrenForFieldName("declarator");
  const i = list.findIndex((x) => x?.id === d?.id);
  return list.slice(i + 1).some((x) => x !== null && wordCount(codeOnly(x.text), name) > 0);
}

// ---------------------------------------------------------------------------------------------------------

interface FileObject {
  readonly name: string;
  readonly decl: Node;
  readonly id: Node;
}

/** Objects declared at file level in this file (not functions, not typedefs). */
function fileLevelObjects(source: SourceContext): Map<string, FileObject> {
  const out = new Map<string, FileObject>();
  const visit = (n: Node) => {
    for (const c of n.namedChildren) {
      if (!c) {
        continue;
      }
      if (c.type === "declaration") {
        for (const d of c.childrenForFieldName("declarator")) {
          if (d && !isFunctionDeclarator(d)) {
            const id = declaredName(d);
            if (id && !out.has(id.text)) {
              out.set(id.text, { name: id.text, decl: c, id });
            }
          }
        }
      } else if (/^preproc_(if|ifdef|else|elif|elifdef)$/.test(c.type) || c.type === "linkage_specification" || c.type === "declaration_list") {
        visit(c);
      }
    }
  };
  if (source.parsed) {
    visit(source.parsed.root);
  }
  return out;
}

/** `*f(void)` -> f */
function declaredFunctionName(d: Node): Node | undefined {
  for (let n: Node | null = d; n; n = n.childForFieldName("declarator")) {
    if (n.type === "function_declarator") {
      return declaredName(n.childForFieldName("declarator"));
    }
  }
  return undefined;
}

function isFunctionDeclarator(d: Node): boolean {
  for (let n: Node | null = d; n; n = n.childForFieldName("declarator")) {
    if (n.type === "function_declarator") {
      return true;
    }
    if (n.type === "parenthesized_declarator") {
      return false; // pointer to function: an object
    }
  }
  return false;
}

/** Walks the function's blocks with a stack of scopes; a declaration that reuses an outer name is reported. */
function shadowing(source: SourceContext, fn: Node, fileObjects: ReadonlyMap<string, FileObject>, out: Finding[]): void {
  const body = fn.childForFieldName("body");
  if (!body) {
    return;
  }
  const params = new Set(parameterNames(fn).map((p) => p.text));
  const isGlobal = (name: string) => fileObjects.has(name) || source.declarations?.varType(name) !== undefined;
  const scopes: Map<string, string>[] = [new Map([...params].map((p) => [p, "parameter"]))];
  const lookup = (name: string): string | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const what = scopes[i].get(name);
      if (what) {
        return what;
      }
    }
    return isGlobal(name) ? "global" : undefined;
  };
  const declare = (decl: Node) => {
    for (const d of decl.childrenForFieldName("declarator")) {
      const id = d && !isFunctionDeclarator(d) ? declaredName(d) : undefined;
      if (!id) {
        continue;
      }
      const outer = lookup(id.text);
      if (outer) {
        out.push(ruleFinding(source, SHADOWING_RULE, id, `${id.text} hides ${outer === "global" ? "a file-level object" : outer === "parameter" ? "a parameter" : "a local variable of an outer block"} with the same name; rename it.`));
      }
      scopes[scopes.length - 1].set(id.text, "local");
    }
  };
  const visit = (n: Node, ownScope: boolean) => {
    if (ownScope) {
      scopes.push(new Map());
    }
    for (const c of n.namedChildren) {
      if (!c) {
        continue;
      }
      if (c.type === "declaration") {
        declare(c);
      } else if (c.type === "compound_statement") {
        visit(c, true);
      } else if (c.type === "for_statement" || c.type === "for_range_loop") {
        scopes.push(new Map());
        const init = c.childForFieldName("initializer");
        if (init?.type === "declaration") {
          declare(init);
        }
        visit(c, false);
        scopes.pop();
      } else if (c.type !== "function_definition" && c.type !== "lambda_expression") {
        visit(c, false);
      }
    }
    if (ownScope) {
      scopes.pop();
    }
  };
  // The outermost body block shares the parameters' scope in C.
  visit(body, false);
}

/** An object used in an interrupt handler and in other code must be volatile, or the compiler may cache it. */
function missingVolatile(source: SourceContext, fileObjects: ReadonlyMap<string, FileObject>, out: Finding[]): void {
  const fns = functionsOf(source);
  const isr = fns.filter(isInterruptHandler);
  if (isr.length === 0) {
    return;
  }
  const isrIds = new Set(isr.map((f) => f.id));
  const usedIn = (f: Node, name: string) => {
    const body = f.childForFieldName("body");
    return body ? wordCount(codeOnly(body.text), name) > 0 && !declaresLocally(body, name) : false;
  };
  for (const obj of fileObjects.values()) {
    if (hasQualifier(obj.decl, "volatile") || hasQualifier(obj.decl, "const") || hasStorage(obj.decl, "extern") || /\bvolatile\b/.test(obj.decl.text.split(obj.name)[0])) {
      continue;
    }
    const inIsr = isr.find((f) => usedIn(f, obj.name));
    const elsewhere = fns.find((f) => !isrIds.has(f.id) && usedIn(f, obj.name));
    if (inIsr && elsewhere) {
      out.push(
        ruleFinding(source, MISSING_VOLATILE_RULE, obj.id, `${obj.name} is used by the interrupt handler ${functionName(inIsr)}() and by ${functionName(elsewhere)}(), but is not volatile; the compiler may keep a stale copy in a register.`)
      );
    }
  }
}

/** By name (sched_tick_isr, TIM2_IRQHandler) or by an interrupt keyword / attribute before the body. */
function isInterruptHandler(f: Node): boolean {
  const body = f.childForFieldName("body");
  const head = body ? f.text.slice(0, body.startIndex - f.startIndex) : f.text;
  return ISR_NAME.test(functionName(f)) || HANDLER_NAME.test(functionName(f)) || /\b(__interrupt|interrupt|__irq)\b/.test(head);
}

function declaresLocally(body: Node, name: string): boolean {
  return body.descendantsOfType("declaration").some((d) => d !== null && d.childrenForFieldName("declarator").some((x) => declaredName(x)?.text === name));
}

/** File-level definitions that are visible to other files although no header declares them. */
function internalLinkage(source: SourceContext, out: Finding[]): void {
  const decls = source.declarations;
  if (!decls || !source.parsed || (source.missingIncludes?.length ?? 0) > 0) {
    return; // without every project header we cannot tell what is declared elsewhere
  }
  const ownPrototypes = new Set<string>();
  for (const c of source.parsed.root.namedChildren) {
    if (c?.type === "declaration") {
      for (const d of c.childrenForFieldName("declarator")) {
        const fd = d && isFunctionDeclarator(d) ? declaredFunctionName(d) : undefined;
        if (fd && hasStorage(c, "static")) {
          ownPrototypes.add(fd.text);
        }
      }
    }
  }
  for (const c of source.parsed.root.namedChildren) {
    if (!c || c.hasError) {
      continue;
    }
    if (c.type === "function_definition") {
      const name = functionName(c);
      if (!name || name === "main" || hasStorage(c, "static") || hasStorage(c, "inline") || ownPrototypes.has(name) || decls.declaredInHeader(name) || ISR_NAME.test(name) || HANDLER_NAME.test(name)) {
        continue;
      }
      const id = declaredName(functionDeclarator(c)?.childForFieldName("declarator") ?? null) ?? c;
      out.push(ruleFinding(source, INTERNAL_LINKAGE_RULE, id, `${name}() is visible to other files but no header declares it; make it static, or declare it in the module's header.`));
    } else if (c.type === "declaration" && !hasStorage(c, "static") && !hasStorage(c, "extern")) {
      for (const d of c.childrenForFieldName("declarator")) {
        const id = d && !isFunctionDeclarator(d) ? declaredName(d) : undefined;
        if (id && !decls.declaredInHeader(id.text)) {
          out.push(ruleFinding(source, INTERNAL_LINKAGE_RULE, id, `${id.text} is visible to other files but no header declares it; make it static, or declare it extern in the module's header.`));
        }
      }
    }
  }
}

function magicNumber(source: SourceContext, n: Node, out: Finding[]): void {
  const v = Number(n.text.replace(/[uUlLfF]+$/, "").replace(/'/g, ""));
  const value = /^0[xX]/.test(n.text) ? parseInt(n.text, 16) : /^0[0-7]+/.test(n.text) ? parseInt(n.text, 8) : v;
  if (PLAIN_NUMBERS.has(value)) {
    return;
  }
  let inFunction = false;
  for (let p = n.parent; p; p = p.parent) {
    switch (p.type) {
      case "preproc_def":
      case "preproc_function_def":
      case "enumerator":
      case "bitfield_clause":
        return;
      case "case_statement":
        if (isInside(n, p.childForFieldName("value"))) {
          return; // case labels are values to match, not tuning constants
        }
        break;
      case "init_declarator": {
        const decl = p.parent;
        if (decl && hasQualifier(decl, "const")) {
          return; // const u32 TIMEOUT_MS = 500U; names the number
        }
        break;
      }
      case "array_declarator":
        if (isInside(n, p.childForFieldName("size"))) {
          return; // the declaration names what the size is for
        }
        break;
      case "function_definition":
        inFunction = true;
        break;
    }
  }
  if (inFunction) {
    out.push(ruleFinding(source, MAGIC_NUMBER_RULE, n, `${n.text} is an unnamed constant; give it a name (#define, enum or const) that says what it means.`, "info"));
  }
}

function isInside(n: Node, outer: Node | null): boolean {
  return !!outer && n.startIndex >= outer.startIndex && n.endIndex <= outer.endIndex;
}
