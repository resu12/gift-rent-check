import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

// Evaluate the actual dependency graph in one bare V8 realm. This linker only
// adapts static ES module syntax; no Node/browser APIs enter deployed modules.
export function portableModules() {
  const context = vm.createContext({}), root = fileURLToPath(new URL('../../tgcloud/lib/', import.meta.url)), modules = new Map();
  const bindings = text => text.split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const [imported, local = imported] = value.split(/\s+as\s+/);
    assert.match(imported, /^[A-Za-z_$][\w$]*$/); assert.match(local, /^[A-Za-z_$][\w$]*$/);
    return {imported, local};
  });
  function load(relative) {
    const path = resolve(root, relative);
    assert.ok(path.startsWith(resolve(root) + sep));
    assert.ok(!/[/\\]private-[^/\\]+\.js$/.test(path));
    if (modules.has(path)) return modules.get(path);
    const parameters = [], dependencies = [], reexports = [];
    let source = readFileSync(path, 'utf8');
    source = source.replace(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])(\.[^'"]+)\2\s*;?/g, (_, names, quote, dependency) => {
      const importedModule = load(resolve(dirname(path), dependency));
      for (const {imported, local} of bindings(names)) {assert.ok(Object.hasOwn(importedModule, imported), `${dependency}:${imported}`); parameters.push(local); dependencies.push(importedModule[imported]);}
      return '';
    });
    source = source.replace(/\bexport\s*\{([^}]+)\}\s*from\s*(['"])(\.[^'"]+)\2\s*;?/g, (_, names, quote, dependency) => {
      const importedModule = load(resolve(dirname(path), dependency));
      for (const {imported, local} of bindings(names)) {assert.ok(Object.hasOwn(importedModule, imported)); reexports.push([local, importedModule[imported]]);}
      return '';
    });
    const exported = [...source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
    source = source.replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const)\s)/g, '');
    assert.doesNotMatch(source, /^\s*(?:import|export)\b/m);
    const factory = vm.runInContext(`(function(${parameters.join(',')}) {\n'use strict';\n${source}\nreturn {${exported.join(',')}};\n})`, context, {filename: path});
    const result = factory(...dependencies);
    for (const [name, value] of reexports) result[name] = value;
    modules.set(path, result); return result;
  }
  return {load, evaluate: source => vm.runInContext(source, context)};
}
