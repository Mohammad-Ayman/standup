/**
 * GET /api/executions/[id]/logs?after=<lastId>
 *
 * Incremental log tail for the execution detail page. Returns up to 500
 * log lines with id > after (ascending) plus the current execution status,
 * so the client knows when to stop polling.
 */
import { NextResponse } from "next/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/auth";
import { getDb } from "@/db/client";
import { executionLogs, executions } from "@/db/schema";

const IdZ = z.coerce.number().int().positive();
const AfterZ = z.coerce.number().int().min(0).catch(0);

const BATCH_LIMIT = 500;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id: rawId } = await context.params;
  const parsedId = IdZ.safeParse(rawId);
  if (!parsedId.success) {
    return NextResponse.json({ error: "invalid execution id" }, { status: 400 });
  }
  const executionId = parsedId.data;

  const url = new URL(request.url);
  const after = AfterZ.parse(url.searchParams.get("after") ?? 0);

  const db = getDb();

  const [execution] = await db
    .select({ status: executions.status })
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);
  if (!execution) {
    return NextResponse.json({ error: "execution not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: executionLogs.id,
      ts: executionLogs.ts,
      stream: executionLogs.stream,
      line: executionLogs.line,
    })
    .from(executionLogs)
    .where(
      and(eq(executionLogs.executionId, executionId), gt(executionLogs.id, after)),
    )
    .orderBy(asc(executionLogs.id))
    .limit(BATCH_LIMIT);

  return NextResponse.json({
    lines: rows.map((row) => ({
      id: row.id,
      ts: row.ts ? row.ts.toISOString() : null,
      stream: row.stream ?? "agent",
      line: row.line,
    })),
    status: execution.status,
  });
}
