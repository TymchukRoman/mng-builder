import type { z } from 'zod';
import { newId, type IdPrefix } from '@manga/shared';
import { NotFoundError, StoreCorruptError } from '../errors.js';
import type { Db } from './db.js';
import type { Repo } from './types.js';

export type Codec = 'value' | 'bool' | 'json';

export interface TableSpec<T> {
  table: string;
  /** Name used in error messages, e.g. 'manga'. */
  entity: string;
  prefix: IdPrefix;
  schema: z.ZodType<T>;
  /** Entity field → column name, or [column, codec]. Plain names use the 'value' codec. */
  columns: Record<string, string | readonly [string, Codec]>;
  hasUpdatedAt: boolean;
  orderBy: string;
}

type Row = Record<string, unknown>;
interface Column { field: string; column: string; codec: Codec }

/** Maps one table to one entity; every row read back is validated with the entity's zod schema. */
export class TableRepo<T extends { id: string }, C, U> implements Repo<T, C, U> {
  private readonly columns: Column[];
  private readonly insertSql: string;
  private readonly updateSql: string;

  constructor(
    protected readonly db: Db,
    protected readonly spec: TableSpec<T>,
    protected readonly now: () => string,
  ) {
    this.columns = Object.entries(spec.columns).map(([field, def]): Column =>
      typeof def === 'string' ? { field, column: def, codec: 'value' } : { field, column: def[0], codec: def[1] },
    );
    const names = this.columns.map((c) => c.column);
    this.insertSql = `INSERT INTO ${spec.table} (${names.join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`;
    this.updateSql = `UPDATE ${spec.table} SET ${names.filter((n) => n !== 'id').map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`;
  }

  get(id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.spec.table} WHERE id = ?`).get(id) as Row | undefined;
    return row === undefined ? null : this.decode(row);
  }

  require(id: string): T {
    const found = this.get(id);
    if (found === null) throw new NotFoundError(this.spec.entity, id);
    return found;
  }

  create(input: C): T {
    const { id, ...rest } = input as unknown as Row & { id?: string };
    const at = this.now();
    const entity = this.spec.schema.parse({
      ...rest,
      id: id ?? newId(this.spec.prefix),
      createdAt: at,
      ...(this.spec.hasUpdatedAt ? { updatedAt: at } : {}),
    });
    this.db.prepare(this.insertSql).run(this.encode(entity));
    return entity;
  }

  update(id: string, patch: U): T {
    const current = this.require(id);
    const changes = Object.fromEntries(Object.entries(patch as unknown as Row).filter(([, v]) => v !== undefined));
    const next = this.spec.schema.parse({
      ...current,
      ...changes,
      id: current.id,
      ...(this.spec.hasUpdatedAt ? { updatedAt: this.now() } : {}),
    });
    this.db.prepare(this.updateSql).run(this.encode(next));
    return next;
  }

  delete(id: string): void {
    const result = this.db.prepare(`DELETE FROM ${this.spec.table} WHERE id = ?`).run(id);
    if (result.changes === 0) throw new NotFoundError(this.spec.entity, id);
  }

  protected listWhere(where: string, ...params: unknown[]): T[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.spec.table} WHERE ${where} ORDER BY ${this.spec.orderBy}`).all(...params) as Row[];
    return rows.map((row) => this.decode(row));
  }

  protected firstWhere(where: string, orderBy: string, ...params: unknown[]): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.spec.table} WHERE ${where} ORDER BY ${orderBy} LIMIT 1`).get(...params) as Row | undefined;
    return row === undefined ? null : this.decode(row);
  }

  protected decode(row: Row): T {
    const id = String(row['id']);
    const obj: Row = {};
    for (const c of this.columns) {
      const value = row[c.column];
      if (value === null || value === undefined) {
        obj[c.field] = null;
      } else if (c.codec === 'json') {
        try {
          obj[c.field] = JSON.parse(String(value));
        } catch {
          throw new StoreCorruptError(this.spec.entity, id, `column ${c.column} is not valid JSON`);
        }
      } else {
        obj[c.field] = c.codec === 'bool' ? value === 1 : value;
      }
    }
    const parsed = this.spec.schema.safeParse(obj);
    if (!parsed.success) {
      throw new StoreCorruptError(this.spec.entity, id, parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; '));
    }
    return parsed.data;
  }

  private encode(entity: T): Row {
    const source = entity as unknown as Row;
    const out: Row = {};
    for (const c of this.columns) {
      const value = source[c.field];
      if (value === null || value === undefined) out[c.column] = null;
      else if (c.codec === 'json') out[c.column] = JSON.stringify(value);
      else if (c.codec === 'bool') out[c.column] = value ? 1 : 0;
      else out[c.column] = value;
    }
    return out;
  }
}
