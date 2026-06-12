import path from "node:path";

// Garantiza que el server corra anclado al root del proyecto sin importar
// desde dónde se lo invoque (.env, data/ y output/ son relativos al cwd).
// Debe ser el PRIMER import de index.ts.
process.chdir(path.resolve(import.meta.dirname, "..", ".."));
