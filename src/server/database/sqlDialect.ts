import type { InArgs, InStatement } from "./contracts.js";

/** Translate only SQL tokens, leaving quoted text, identifiers and comments untouched. */
export function postgresStatement(statement: InStatement, args?: InArgs) {
  const sql = typeof statement === "string" ? statement : statement.sql;
  const parameters = typeof statement === "string" ? args ?? [] : statement.args ?? [];
  if (!Array.isArray(parameters)) throw new Error("PostgreSQL requires positional parameters");
  let text = "";
  let position = 0;
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    const quoted = rest.match(/^(?:'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)/);
    if (quoted) {
      let token = quoted[0];
      if (token.startsWith("$")) {
        const end = sql.indexOf(token, i + token.length);
        if (end < 0) throw new Error("Unterminated SQL string");
        token = sql.slice(i, end + token.length);
      }
      text += token;
      i += token.length;
    } else if (sql[i] === "?") {
      const value = parameters[position++];
      // Explicit numeric types also cover expressions such as ? + ? in rate-limit UPSERTs.
      const type = typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value))
        ? "::bigint" : typeof value === "number" ? "::double precision" : "";
      text += `$${position}${type}`;
      i++;
    } else {
      const word = rest.match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0];
      text += word ? (word.toUpperCase() === "LIKE" ? "ILIKE" : word) : sql[i];
      i += word?.length ?? 1;
    }
  }
  if (position !== parameters.length) throw new Error("SQL parameter count mismatch");
  return { text, values: parameters };
}
