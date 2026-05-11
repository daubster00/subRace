import { NextRequest, NextResponse } from 'next/server';

async function safeCompare(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const aView = new Uint8Array(aHash);
  const bView = new Uint8Array(bHash);
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= aView[i]! ^ bView[i]!;
  }
  return diff === 0;
}

function unauthorizedResponse(): NextResponse {
  console.log('[auth] basic_auth_failed');
  return new NextResponse(null, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="SubRace"' },
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const expectedUser = process.env.BASIC_AUTH_USERNAME ?? '';
  const expectedPass = process.env.BASIC_AUTH_PASSWORD ?? '';

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Basic ')) {
    return unauthorizedResponse();
  }

  const base64 = authHeader.slice(6);
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(
      Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    );
  } catch {
    return unauthorizedResponse();
  }

  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) {
    return unauthorizedResponse();
  }

  const username = decoded.slice(0, colonIdx);
  const password = decoded.slice(colonIdx + 1);

  const [userOk, passOk] = await Promise.all([
    safeCompare(username, expectedUser),
    safeCompare(password, expectedPass),
  ]);

  if (!userOk || !passOk) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api/health|_next/static|_next/image|favicon\\.ico).*)',
  ],
};
