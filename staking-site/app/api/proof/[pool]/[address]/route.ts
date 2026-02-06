import { NextResponse } from "next/server";
import { head, list } from "@vercel/blob";

/**
 * Serve a user's Merkle proof for a given pool.
 * GET /api/proof/:pool/:address
 *
 * Returns: { poolIndex, address, balance, epochId, proof: string[] }
 */
export async function GET(
  _request: Request,
  { params }: { params: { pool: string; address: string } }
) {
  const { pool, address } = params;
  const poolIndex = parseInt(pool, 10);

  if (isNaN(poolIndex) || !address.startsWith("G")) {
    return NextResponse.json(
      { error: "Invalid pool index or address" },
      { status: 400 }
    );
  }

  const blobKey = `proofs/${poolIndex}/${address}.json`;

  try {
    // Check if proof exists
    const blobInfo = await head(blobKey);
    if (!blobInfo) {
      return NextResponse.json(
        { error: "No proof found for this address in this pool" },
        { status: 404 }
      );
    }

    // Fetch the proof data (add cache-busting)
    const response = await fetch(blobInfo.url + `?t=${Date.now()}`);
    const proofData = await response.json();

    // Prevent caching - proofs change with each epoch
    return NextResponse.json(proofData, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "No proof found for this address in this pool" },
      { status: 404 }
    );
  }
}
