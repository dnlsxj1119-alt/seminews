#!/usr/bin/env bash
# GitHub 푸시 + Cloudflare 배포를 한 번에 한다.
#
# git push        는 코드를 GitHub에 보관만 할 뿐 사이트를 바꾸지 않고,
# wrangler deploy 는 사이트를 바꾸지만 GitHub에는 아무것도 남기지 않는다.
# 둘 다 필요해서 매번 두 번 치는 게 번거로우니 묶어둔 것.
#
# 사용법:  ./deploy.sh

set -uo pipefail
cd "$(dirname "$0")"

SITE="https://seminews.ekdusdl02.workers.dev/"

if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  커밋하지 않은 변경이 있습니다:"
  git status --short | sed 's/^/     /'
  echo "   (커밋 안 한 내용도 사이트에는 그대로 배포됩니다. GitHub에만 안 올라갑니다)"
  echo
fi

echo "▶ 1/2  GitHub에 올리는 중..."
if git push; then
  echo "   완료"
else
  echo "   ⚠️ 푸시 실패 - 배포는 계속 진행합니다"
fi
echo

echo "▶ 2/2  Cloudflare에 배포하는 중..."
if ! npx wrangler deploy; then
  echo
  echo "❌ 배포 실패. 위 메시지를 확인하세요."
  exit 1
fi

echo
echo "✅ 끝났습니다 → $SITE"
echo "   화면이 그대로면 Cmd+Shift+R 로 새로고침하세요 (최대 5분 캐시)"
