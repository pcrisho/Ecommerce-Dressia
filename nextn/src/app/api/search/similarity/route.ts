import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Server-side API route that simulates embedding generation (for now) and proxies
// the vector to the Cloud Function (Vertex AI proxy).

// Optional: import library to obtain ID token for calling a protected Cloud Function
import { GoogleAuth } from 'google-auth-library';

import { vestidos as allDresses } from '@/lib/data';

const VECTOR_LENGTH = 1408;
const DEFAULT_NEIGHBORS = 5;

async function getIdTokenHeader(audience: string) {
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(audience);
  // client.getRequestHeaders() returns headers including Authorization: Bearer ...
  return await client.getRequestHeaders();
}

export async function POST(req: NextRequest) {
  try {
    // Read optional body (we ignore uploaded image for this simulated flow)
    // Accept JSON bodies but we won't require any field for the simulation.
    let body: any = {};
    try {
      body = await req.json();
    } catch (e) {
      body = {};
    }

    const neighborCount = Number(body?.neighbor_count ?? DEFAULT_NEIGHBORS);

    // Generate a simulated embedding vector (for testing/orchestration)
    const feature_vector = Array.from({ length: VECTOR_LENGTH }, () => Math.random());

    const cfUrl = process.env.VECTOR_SEARCH_CF_URL;
    if (!cfUrl) {
      return NextResponse.json({ error: 'Server not configured: VECTOR_SEARCH_CF_URL missing' }, { status: 500 });
    }

    const payload = {
      feature_vector,
      neighbor_count: neighborCount,
    };

    // Build headers. If an audience is configured, try to obtain an ID token header.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const audience = process.env.VECTOR_SEARCH_CF_AUDIENCE;
    if (audience) {
      try {
        const authHeaders = await getIdTokenHeader(audience);
        Object.assign(headers, authHeaders as Record<string, string>);
      } catch (err) {
        console.warn('Could not obtain ID token; continuing without it:', err);
      }
    }

    const resp = await fetch(cfUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return NextResponse.json({ error: 'Cloud Function error', status: resp.status, detail: text }, { status: 502 });
    }

    const cfJson = await resp.json();
    const neighbors = cfJson.results ?? [];

    // Map neighbor ids to local catalog items when possible
    const mapped = neighbors
      .map((n: any) => {
        const id = String(n.id);
        const prod = allDresses.find((d) => String(d.id) === id);
        return {
          id,
          distance: n.distance ?? null,
          score: n.score ?? null,
          product: prod ?? null,
        };
      })
      .filter((x: any) => x.product !== null);

    return NextResponse.json({ results: mapped });
  } catch (err) {
    console.error('Error in /api/search/similarity', err);
    return NextResponse.json({ error: 'Internal server error', detail: String(err) }, { status: 500 });
  }
}
