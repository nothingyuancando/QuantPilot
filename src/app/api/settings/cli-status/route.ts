import { NextResponse } from 'next/server';
import type { CLIStatus } from '@/types/backend';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { checkModelAvailability } from '@/lib/platform/model-availability';

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'quant.data.read',
    });
    const status: CLIStatus = {
      pi: await checkModelAvailability(),
    };
    const response = NextResponse.json(status);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to check PI Agent provider status:', error);
    return NextResponse.json(
      {
        error: 'Failed to check PI Agent provider status',
        message: '模型状态检查失败，请稍后重新检查。',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
