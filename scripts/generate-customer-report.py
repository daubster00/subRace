# -*- coding: utf-8 -*-
"""고객용 검토 보고서 PDF 생성기.

수정요청사항_2.pdf의 11개 이슈를 운영 DB/로그로 검증한 결과와
개선 방향만 담는다. 약속 수위는 "~로 검토 예정" 수준.
"""

from datetime import datetime
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, PageBreak,
    Paragraph, Spacer, Table, TableStyle, KeepTogether,
)

# 한글 폰트 등록 (맑은 고딕)
FONT_DIR = Path(r"C:/Windows/Fonts")
pdfmetrics.registerFont(TTFont("Malgun", str(FONT_DIR / "malgun.ttf")))
pdfmetrics.registerFont(TTFont("MalgunBold", str(FONT_DIR / "malgunbd.ttf")))

OUTPUT = Path(r"D:/projects/SubRace/자료/수정요청사항_2_검토보고서.pdf")
TODAY = "2026년 6월 5일"

# ─────────────────────────── 스타일 ───────────────────────────
styles = getSampleStyleSheet()

TITLE = ParagraphStyle(
    "Title", parent=styles["Title"],
    fontName="MalgunBold", fontSize=22, leading=28,
    alignment=TA_CENTER, textColor=colors.HexColor("#1a1a1a"),
    spaceAfter=6,
)
SUBTITLE = ParagraphStyle(
    "Subtitle", parent=styles["Normal"],
    fontName="Malgun", fontSize=11, leading=14,
    alignment=TA_CENTER, textColor=colors.HexColor("#666666"),
    spaceAfter=24,
)
H1 = ParagraphStyle(
    "H1", parent=styles["Heading1"],
    fontName="MalgunBold", fontSize=15, leading=22,
    textColor=colors.HexColor("#1a1a1a"),
    spaceBefore=14, spaceAfter=8,
)
H2 = ParagraphStyle(
    "H2", parent=styles["Heading2"],
    fontName="MalgunBold", fontSize=12.5, leading=18,
    textColor=colors.HexColor("#2a2a2a"),
    spaceBefore=10, spaceAfter=5,
)
BODY = ParagraphStyle(
    "Body", parent=styles["Normal"],
    fontName="Malgun", fontSize=10.5, leading=16,
    textColor=colors.HexColor("#1a1a1a"),
    spaceAfter=6, alignment=TA_LEFT,
)
BODY_SMALL = ParagraphStyle(
    "BodySmall", parent=BODY,
    fontSize=9.5, leading=14,
)
BULLET = ParagraphStyle(
    "Bullet", parent=BODY,
    leftIndent=14, bulletIndent=2,
)
CALLOUT = ParagraphStyle(
    "Callout", parent=BODY,
    fontName="Malgun", fontSize=10, leading=15,
    leftIndent=10, rightIndent=10,
    backColor=colors.HexColor("#f5f7fb"),
    borderColor=colors.HexColor("#d0d7e2"), borderWidth=0.5,
    borderPadding=8, spaceBefore=4, spaceAfter=8,
)


# ─────────────────────────── 헬퍼 ───────────────────────────
def p(text, style=BODY):
    return Paragraph(text, style)


def bullets(items):
    return [Paragraph(f"• {t}", BULLET) for t in items]


def channel_table(rows):
    """채널 검증 결과 표. rows = [(label, value), ...]"""
    t = Table(rows, colWidths=[55 * mm, 105 * mm])
    t.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), "Malgun", 10),
        ("FONT", (0, 0), (0, -1), "MalgunBold", 10),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#444444")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f5f5f7")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#e0e0e0")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
    ]))
    return t


def issue_table(rows):
    """11개 이슈 매핑 표 — 셀 안 텍스트는 Paragraph로 감싸 자동 줄바꿈."""
    cell_body = ParagraphStyle(
        "CellBody", fontName="Malgun", fontSize=8.8, leading=12,
        textColor=colors.HexColor("#1a1a1a"),
    )
    cell_status = ParagraphStyle(
        "CellStatus", fontName="MalgunBold", fontSize=8.8, leading=12,
        textColor=colors.HexColor("#1a3a6a"),
        alignment=TA_CENTER,
    )
    cell_num = ParagraphStyle(
        "CellNum", fontName="MalgunBold", fontSize=9.5, leading=12,
        textColor=colors.HexColor("#444444"),
        alignment=TA_CENTER,
    )

    header = [
        Paragraph("#", ParagraphStyle("h", fontName="MalgunBold", fontSize=9.5,
                                       textColor=colors.white, alignment=TA_CENTER)),
        Paragraph("고객 지적 사항", ParagraphStyle("h", fontName="MalgunBold",
                                                fontSize=9.5, textColor=colors.white)),
        Paragraph("검토 결과", ParagraphStyle("h", fontName="MalgunBold", fontSize=9.5,
                                            textColor=colors.white, alignment=TA_CENTER)),
        Paragraph("개선 방향", ParagraphStyle("h", fontName="MalgunBold", fontSize=9.5,
                                            textColor=colors.white)),
    ]
    data = [header]
    for num, issue, status, plan in rows:
        data.append([
            Paragraph(num, cell_num),
            Paragraph(issue, cell_body),
            Paragraph(status, cell_status),
            Paragraph(plan, cell_body),
        ])

    t = Table(data, colWidths=[10 * mm, 55 * mm, 24 * mm, 81 * mm], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2a3a5a")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#f8f9fb")]),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#e0e0e0")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, colors.HexColor("#1a2540")),
    ]))
    return t


# ─────────────────────────── 본문 빌드 ───────────────────────────
story = []

# 표지 / 헤더
story.append(p("수정요청사항 검토 결과 보고서", TITLE))
story.append(p(f"작성일 : {TODAY}", SUBTITLE))

# 인사
story.append(p(
    "안녕하세요. 보내주신 수정요청사항을 운영 서버의 실제 데이터로 하나씩 확인했습니다. "
    "지적해 주신 내용 대부분이 실제로 발생하고 있는 현상이 맞았고, "
    "확인 과정에서 추가로 알아낸 원인도 함께 정리했습니다.",
    BODY,
))
story.append(p(
    "이 보고서는 (1) 채널별 실측 결과, (2) 화면 움직임 관련 검증, "
    "(3) 11개 이슈별 정리와 개선 방향 순서로 되어 있습니다.",
    BODY,
))

# ──────── 1. 채널별 실측 ────────
story.append(p("1. 지목해주신 3개 채널 실측 결과", H1))
story.append(p(
    "TaikisLife · My No War · Yuka Kinoshita 세 채널의 현재 상태와 최근 변동을 "
    "운영 서버에서 직접 조회해 비교했습니다.",
    BODY,
))

# TaikisLife
story.append(p("TaikisLife — 추정치가 따라가지 못한다는 지적", H2))
story.append(channel_table([
    ["현재 실제 구독자 수", "5,680,000명"],
    ["현재 화면 표시값", "5,682,015명"],
    ["오늘 표시값의 최대 상승 한도", "5,688,500명 (실제값 +8,500)"],
    ["최근 5일간 실제 상승 속도", "약 56,000명/일 (5,400,000 → 5,680,000)"],
    ["최근 가장 빠른 날 상승 속도", "약 120,000명/일 (5월 31일)"],
]))
story.append(Spacer(1, 6))
story.append(p(
    "<b>확인된 현상</b> — 지적해주신 대로 추정치가 실제 상승 속도를 따라가지 못합니다. "
    "현재 알고리즘이 \"다음 마일스톤(예: 5,690,000)까지 남은 거리의 85% 지점\"을 "
    "그날의 표시값 상한으로 잡는데, 오늘은 그 상한이 +8,500밖에 안 됩니다. "
    "실제로는 하루 5만~12만씩 오르는 채널이라 상한 자체가 부족합니다.",
    BODY,
))

# My No War
story.append(p("My No War — 실제로 떨어졌는데 추정치는 계속 올랐다는 지적", H2))
story.append(channel_table([
    ["현재 실제 구독자 수", "8,590,000명"],
    ["하루 전 실제 구독자 수", "8,600,000명 (10,000명 감소 발생)"],
    ["현재 화면 표시값", "8,598,155명 (실제값보다 +8,155명 위)"],
    ["하락 데이터가 추정에 반영됐는지", "반영 안 됨 (원인은 아래)"],
]))
story.append(Spacer(1, 6))
story.append(p(
    "<b>확인된 현상 + 추가 원인</b> — 실제로 8,600,000 → 8,590,000으로 1만 명 감소가 "
    "6월 2일에 발생했지만, 이 감소 기록이 추정 계산에 들어가는 \"마일스톤 기록\"에는 "
    "저장되지 않았습니다. 같은 구독자 수(8,590,000)가 한 달 전(5월 10일) 상승 도중에 "
    "이미 한 번 기록되어 있어, 시스템이 \"이미 있는 값\"으로 보고 중복 저장을 막은 결과입니다. "
    "그래서 추정 로직 입장에서는 5월의 상승 추세만 보이고, 최근의 하락은 보이지 않아 "
    "표시값이 계속 위로 향한 상태입니다.",
    BODY,
))
story.append(Paragraph(
    "<b>이 현상은 보고서를 작성하며 새로 알게 된 부분입니다.</b> "
    "단순한 반응 지연이 아니라, 하락 신호 자체가 누락되는 구조였습니다.",
    CALLOUT,
))

# Yuka Kinoshita
story.append(p("Yuka Kinoshita — 장기적으로 감소 중인데 상승으로 표시된다는 지적", H2))
story.append(channel_table([
    ["현재 실제 구독자 수", "5,160,000명"],
    ["현재 화면 표시값", "5,163,025명"],
    ["오늘 표시값 변화 예측", "+83명 (사실상 양수 고정값)"],
    ["보유한 마일스톤 기록", "2건만 존재 (3월 5,170,000 → 4월 5,160,000)"],
    ["보유 기록이 보여주는 실제 흐름", "한 달에 약 1만 명 감소"],
]))
story.append(Spacer(1, 6))
story.append(p(
    "<b>확인된 현상</b> — 지적이 맞습니다. 이 채널은 마일스톤 기록이 2건뿐이라 "
    "현재 알고리즘이 \"표본 부족\"으로 판단해 회귀 분석을 건너뛰고, "
    "대신 \"채널 규모에 비례한 최소 상승값\"을 강제로 사용하고 있습니다. "
    "이 폴백 값이 항상 양수라서, 실제로 감소 중인 채널도 항상 약간씩 상승하는 것처럼 표시됩니다.",
    BODY,
))

# ──────── 2. 화면 움직임 관련 ────────
story.append(PageBreak())
story.append(p("2. 숫자 움직임 관련 검증", H1))

story.append(p("증감폭이 40~50씩 튀는 현상", H2))
story.append(p(
    "오늘 전체 150개 채널의 평균 변경폭을 채널 규모별로 집계했습니다.",
    BODY,
))
size_tbl = Table(
    [
        ["채널 규모", "채널 수", "1회당 평균 변경폭", "허용 상한"],
        ["100만 미만", "1개", "약 1~2", "10"],
        ["100만 ~ 1,000만", "124개", "약 11", "30"],
        ["1,000만 이상", "25개", "약 32 (상위 5채널은 42~56)", "80"],
    ],
    colWidths=[40 * mm, 25 * mm, 60 * mm, 30 * mm],
    repeatRows=1,
)
size_tbl.setStyle(TableStyle([
    ("FONT", (0, 0), (-1, -1), "Malgun", 10),
    ("FONT", (0, 0), (-1, 0), "MalgunBold", 10),
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2a3a5a")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("ALIGN", (1, 0), (-1, -1), "CENTER"),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1),
     [colors.white, colors.HexColor("#f8f9fb")]),
    ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
story.append(size_tbl)
story.append(Spacer(1, 6))
story.append(p(
    "<b>확인된 현상</b> — 지적이 맞습니다. 1,000만 이상 대형 채널에서는 "
    "한 번에 40~80명씩 움직이는 경우가 빈번하게 발생하고 있습니다. "
    "현재 코드의 변경폭 상한이 이 규모대에서 80으로 잡혀 있는 게 원인입니다.",
    BODY,
))

story.append(p("30분~1시간 단위로 보면 감소처럼 보이는 채널", H2))
story.append(p(
    "<b>확인된 현상</b> — 사실입니다. 현재 알고리즘은 그날의 방향(상승/하락)을 "
    "정한 뒤에도, 매 변경마다 10~25% 확률로 반대 방향 값을 한 번씩 섞도록 되어 있습니다. "
    "자연스러운 흔들림을 주려는 의도였지만, 한 시간 안에 7~12회 변경이 일어나면 "
    "우연히 반대 방향이 몰리는 구간이 자주 생겨 \"오르는 채널인데 1시간 동안 떨어진 것처럼 "
    "보인다\"는 현상으로 이어집니다.",
    BODY,
))

story.append(p("화면이 멈춰 보이는 현상", H2))
story.append(p(
    "현재 시점 기준으로는 모든 채널이 \"다음 변경 예정 시각\"을 가지고 있어 "
    "완전히 멈춘 채널은 없습니다. 다만 노출 순위가 낮은 채널은 평균 변경 간격이 "
    "6~24분이라, 한 화면에서 보면 멈춘 것처럼 느껴질 수 있습니다. "
    "특히 표시값이 그날의 상한에 도달한 채널은 더 이상 올라가지 않고 멈춥니다.",
    BODY,
))

story.append(p("감소 전환 시 '85% 수준' 으로 떨어지는 현상", H2))
story.append(p(
    "지적해주신 \"85%\"는 현재 시스템 설정값과 정확히 일치합니다. "
    "표시값의 일일 상한을 \"실제값에서 다음 마일스톤까지 거리의 85% 지점\"으로 "
    "잡고 있고, 이 값이 \"95%\"가 되면 표시값이 실제 마일스톤 직전까지 더 가깝게 "
    "올라갈 수 있습니다. 요청하신 0.85 → 0.95 변경을 우선 검토 대상으로 두고 있습니다.",
    BODY,
))

# ──────── 3. 이슈 매핑 표 ────────
story.append(PageBreak())
story.append(p("3. 보내주신 11개 항목별 검토 결과", H1))
story.append(p(
    "수정요청사항에 적어주신 순서대로 정리했습니다. \"확인됨\"은 운영 데이터로 "
    "현상을 직접 재현 또는 관측한 항목이고, \"제안 검토\"는 코드 변경 방향에 대한 "
    "제안을 함께 검토하기로 한 항목입니다.",
    BODY,
))
story.append(Spacer(1, 4))

issues = [
    ["1",
     "TaikisLife 추정치가 실제 상승세를 못 따라감",
     "확인됨",
     "표시값 상한을 더 위로 끌어올리는 방향 (아래 11번 항목과 연관)으로 검토 예정."],
    ["2",
     "My No War — 하락 전환이 추정치에 반영되지 않음",
     "확인됨",
     "하락 기록이 시스템에 저장되지 않는 원인을 함께 발견함. 같은 구독자 수의 "
     "이전 기록과 충돌해 누락되는 구조를 개선하는 방향으로 검토 예정."],
    ["3",
     "Yuka Kinoshita — 감소 중인데 상승으로 표시",
     "확인됨",
     "마일스톤 기록이 부족할 때 사용하는 폴백 값이 항상 양수인 점을 개선하는 "
     "방향으로 검토 예정 (정체 또는 0에 가까운 값으로)."],
    ["4",
     "증감폭이 한 번에 40~50씩 튐",
     "확인됨",
     "대형 채널(1,000만 이상)의 한 번 변경폭 상한을 낮추고, 같은 양을 더 "
     "여러 번에 나누어 적용하는 방향으로 검토 예정."],
    ["5",
     "감소를 더 부드럽게 (작게 / 적게 / 나눠서)",
     "검토 예정",
     "하락 방향 변경폭을 상승보다 더 작게 제한하는 방향으로 검토 예정."],
    ["6",
     "30분 / 1시간 단위로 보면 감소처럼 보이는 현상",
     "확인됨",
     "그날의 방향성을 더 강하게 유지하도록 반대 방향 섞임 비율을 낮추는 "
     "방향으로 검토 예정."],
    ["7",
     "최근 마일스톤 간격을 기준으로 속도를 계산하는 방식 제안",
     "제안 검토",
     "현재의 \"긴 기간 평균\" 방식과 비교 테스트 후 적용 여부 결정 예정. "
     "급상승 채널 반응 속도 개선에 효과가 있을 것으로 봄."],
    ["8",
     "오래된 마일스톤 데이터의 영향이 너무 큼",
     "확인됨",
     "추정 계산에 사용하는 기간을 더 짧게 줄이는 방향으로 검토 예정 "
     "(7번 변경과 함께 진행)."],
    ["9",
     "큰 감소는 실제 API 하락이 확인된 경우에만 허용",
     "제안 검토",
     "타당한 제안으로 보아 5번과 함께 적용 검토 예정."],
    ["10",
     "Playboard 유료 데이터 활용 (마일스톤 변화가 없는 채널 한정)",
     "별도 검토",
     "기술적 가능성은 있으나 유료 서비스 약관과 데이터 갱신 빈도 확인이 "
     "선행 필요. 별도 항목으로 검토 예정."],
    ["11",
     "화면이 멈춰 보이는 현상 — 더 자주 움직이게",
     "확인됨",
     "표시값이 그날의 상한에 도달하면 멈추는 점을 함께 조정하는 방향으로 "
     "검토 예정 (1번·6번 항목과 연관)."],
    ["12",
     "감소 시 85% 수준이 어색함 → 95% 수준으로",
     "확인됨",
     "지적하신 값(0.85)과 시스템 설정값이 일치. 0.95 적용을 우선 검토 예정. "
     "다만 0.95로 올리면 실제 API 값을 잠시 넘어설 가능성이 있어 함께 보완책 검토."],
]
story.append(issue_table(issues))

# ──────── 4. 다음 단계 ────────
story.append(PageBreak())
story.append(p("4. 다음 단계", H1))
story.append(p(
    "위 검토 결과를 토대로, 다음 순서로 진행할 예정입니다. "
    "확정된 일정은 항목별 변경 영향 검토 후 별도로 안내드리겠습니다.",
    BODY,
))

next_steps = [
    "<b>먼저 적용 검토</b> — 마일스톤 하락 기록이 누락되는 현상 (2번 항목). "
    "이 부분이 해결되어야 다른 항목들도 정확하게 반영됨.",

    "<b>이어서 적용 검토</b> — 표시값 상한 비율 0.85 → 0.95 조정 (12번), "
    "대형 채널 변경폭 상한 축소 (4번), 하락 방향 변경폭 별도 제한 (5·9번).",

    "<b>알고리즘 변경 검토</b> — 최근 마일스톤 간격 기반 속도 계산 방식 (7·8번) 도입. "
    "현재 방식과 동시 운영해 비교 후 전환 여부 결정.",

    "<b>별도 검토</b> — Playboard 데이터 활용 (10번). "
    "유료 서비스 약관·갱신 빈도·연동 가능성 사전 확인 후 진행 여부 안내.",

    "<b>적용 후 재검증</b> — 모든 변경 적용 후 다시 TaikisLife · My No War · "
    "Yuka Kinoshita 세 채널의 동작을 재측정해서 보내드릴 예정.",
]
for s in next_steps:
    story.append(Paragraph(f"• {s}", BULLET))

story.append(Spacer(1, 14))
story.append(p(
    "꼼꼼하게 정리해서 보내주신 덕분에 단순 반응 지연 뒤에 있던 데이터 누락 현상까지 "
    "함께 발견할 수 있었습니다. 감사합니다. 추가 의견 있으시면 언제든지 말씀해주세요.",
    BODY,
))


# ─────────────────────────── 문서 생성 ───────────────────────────
def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    doc = BaseDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=20 * mm, bottomMargin=18 * mm,
        title="수정요청사항 검토 결과 보고서",
        author="SubRace",
    )
    frame = Frame(
        doc.leftMargin, doc.bottomMargin,
        doc.width, doc.height,
        id="normal",
    )

    def footer(canvas, doc_):
        canvas.saveState()
        canvas.setFont("Malgun", 8.5)
        canvas.setFillColor(colors.HexColor("#888888"))
        canvas.drawRightString(
            A4[0] - 20 * mm, 10 * mm,
            f"- {doc_.page} -",
        )
        canvas.drawString(
            20 * mm, 10 * mm,
            f"수정요청사항 검토 결과 보고서 · {TODAY}",
        )
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=footer)])
    doc.build(story)
    print(f"OK: {OUTPUT}")


if __name__ == "__main__":
    build()
