import * as SQLite from 'expo-sqlite';
import { captureToRow, type CaptureRecord } from './types';

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

async function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await SQLite.openDatabaseAsync('yugen.db');
      await db.execAsync(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS captures (
          id TEXT PRIMARY KEY NOT NULL,
          created_at TEXT NOT NULL,
          language TEXT NOT NULL,
          source TEXT NOT NULL,
          image_uri TEXT NOT NULL,
          image_metadata TEXT NOT NULL,
          raw_text TEXT NOT NULL,
          regions TEXT NOT NULL,
          corrected_text TEXT NOT NULL,
          selected_region_id TEXT,
          status TEXT NOT NULL
        );
      `);
      return db;
    })().catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
  }
  return databasePromise;
}

export async function saveCapture(capture: CaptureRecord): Promise<void> {
  const db = await database();
  await writeCapture(db, capture);
}

async function writeCapture(db: SQLite.SQLiteDatabase, capture: CaptureRecord): Promise<void> {
  const row = captureToRow(capture);
  await db.runAsync(
    `INSERT INTO captures (
      id, created_at, language, source, image_uri, image_metadata, raw_text,
      regions, corrected_text, selected_region_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      created_at = excluded.created_at,
      language = excluded.language,
      source = excluded.source,
      image_uri = excluded.image_uri,
      image_metadata = excluded.image_metadata,
      raw_text = excluded.raw_text,
      regions = excluded.regions,
      corrected_text = excluded.corrected_text,
      selected_region_id = excluded.selected_region_id,
      status = excluded.status;`,
    row.id,
    row.created_at,
    row.language,
    row.source,
    row.image_uri,
    row.image_metadata,
    row.raw_text,
    row.regions,
    row.corrected_text,
    row.selected_region_id,
    row.status,
  );
}
