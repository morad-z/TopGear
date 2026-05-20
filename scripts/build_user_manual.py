"""
TopGear — Hebrew user manual PDF generator.

Run:
    python scripts/build_user_manual.py

Writes the manual to docs/TopGear-User-Manual.pdf. The script uses
ReportLab with Arial (which ships on Windows and includes Hebrew
glyphs) and python-bidi to handle RTL bidirectional text rendering
correctly.

Why Arial: it's the only universally-available Hebrew-capable TTF on
a stock Windows install. The app itself uses Heebo via web fonts, but
ReportLab needs a local TTF and Heebo's variable-font file caused
glyph-loading issues. Arial is a close-enough Hebrew sans-serif for a
printed manual.

This script is run manually (not at build-time) — re-run it whenever
the manual content needs updating, then commit the resulting PDF.
"""

import os
import shutil
from pathlib import Path

from bidi.algorithm import get_display
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.lib.enums import TA_RIGHT, TA_CENTER

# --- Paths ---
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "docs" / "TopGear-User-Manual.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

# --- Fonts ---
# Use Windows system Arial which includes Hebrew glyphs. Fall back to
# DejaVuSans if Arial is missing (Linux/macOS dev box).
def find_font():
    candidates = [
        ("Arial", Path(r"C:\Windows\Fonts\arial.ttf"), Path(r"C:\Windows\Fonts\arialbd.ttf")),
        ("DejaVu", Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
                   Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")),
    ]
    for name, regular, bold in candidates:
        if regular.exists() and bold.exists():
            return name, regular, bold
    raise RuntimeError(
        "No Hebrew-capable TTF found. Install Arial (Windows) or DejaVu (Linux/Mac)."
    )

font_name, regular_path, bold_path = find_font()
pdfmetrics.registerFont(TTFont("HebrewBody", str(regular_path)))
pdfmetrics.registerFont(TTFont("HebrewBold", str(bold_path)))


def he(text: str) -> str:
    """Convert logical-order Hebrew text into the visual order
    ReportLab needs. python-bidi handles mixed Hebrew + English +
    numbers correctly per the Unicode Bidi Algorithm."""
    # ReportLab passes paragraphs through its own line-breaking
    # before painting glyphs; we apply BIDI line-by-line so the
    # algorithm sees each visual line independently.
    return "\n".join(get_display(line) for line in text.split("\n"))


# --- Brand palette (matches the app: Workshop Dashboard direction) ---
BRASS = colors.HexColor("#b8651b")
INK = colors.HexColor("#1f2937")
INK2 = colors.HexColor("#4b5563")
MUTED = colors.HexColor("#6b7280")
LINE = colors.HexColor("#e5e7eb")
PANEL_SOFT = colors.HexColor("#f7f3ec")
ACCENT_SOFT = colors.HexColor("#fbeed7")
SUCCESS = colors.HexColor("#15803d")


# --- Paragraph styles ---
def style(name, **kw):
    base = dict(
        fontName="HebrewBody",
        fontSize=11,
        leading=16,
        alignment=TA_RIGHT,
        textColor=INK,
        spaceBefore=2,
        spaceAfter=4,
    )
    base.update(kw)
    return ParagraphStyle(name=name, **base)


styles = {
    "title":   style("title",   fontName="HebrewBold", fontSize=28, leading=34, textColor=INK,  spaceAfter=4, alignment=TA_RIGHT),
    "subtitle":style("subtitle",fontName="HebrewBody", fontSize=12, leading=16, textColor=MUTED,spaceAfter=18,alignment=TA_RIGHT),
    "h1":      style("h1",      fontName="HebrewBold", fontSize=20, leading=26, textColor=BRASS,spaceBefore=14, spaceAfter=8),
    "h2":      style("h2",      fontName="HebrewBold", fontSize=15, leading=20, textColor=INK,  spaceBefore=10, spaceAfter=4),
    "h3":      style("h3",      fontName="HebrewBold", fontSize=12, leading=16, textColor=INK,  spaceBefore=8,  spaceAfter=2),
    "body":    style("body",    fontName="HebrewBody", fontSize=11, leading=16, textColor=INK),
    "bullet":  style("bullet",  fontName="HebrewBody", fontSize=11, leading=16, textColor=INK, leftIndent=4, rightIndent=18),
    "muted":   style("muted",   fontName="HebrewBody", fontSize=10, leading=14, textColor=MUTED),
    "callout": style("callout", fontName="HebrewBody", fontSize=10.5, leading=15, textColor=INK, backColor=ACCENT_SOFT, borderColor=BRASS, borderWidth=0.6, borderPadding=8, spaceBefore=8, spaceAfter=8),
    "cover_title": style("cover_title", fontName="HebrewBold", fontSize=52, leading=60, textColor=INK, alignment=TA_CENTER, spaceAfter=4),
    "cover_sub":   style("cover_sub",   fontName="HebrewBody", fontSize=16, leading=22, textColor=MUTED, alignment=TA_CENTER, spaceAfter=40),
    "cover_brass": style("cover_brass", fontName="HebrewBold", fontSize=14, leading=18, textColor=BRASS, alignment=TA_CENTER, spaceAfter=6),
}


# --- Layout: A4 with RTL frame ---
def on_page(canvas, doc):
    """Page chrome — slim brass header rule + footer with page number."""
    canvas.saveState()
    # Top brass rule
    canvas.setStrokeColor(BRASS)
    canvas.setLineWidth(2)
    canvas.line(20 * mm, A4[1] - 14 * mm, A4[0] - 20 * mm, A4[1] - 14 * mm)
    # Footer
    canvas.setFont("HebrewBody", 9)
    canvas.setFillColor(MUTED)
    page_num = f"{doc.page}"
    canvas.drawString(20 * mm, 10 * mm, page_num)
    canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, he("TopGear — מדריך למשתמש"))
    canvas.restoreState()


def on_cover(canvas, doc):
    """Cover page: no header rule, brass corner accent only."""
    canvas.saveState()
    # Brass corner block (top-right in visual)
    canvas.setFillColor(BRASS)
    canvas.rect(A4[0] - 50 * mm, A4[1] - 50 * mm, 50 * mm, 50 * mm, stroke=0, fill=1)
    # Soft panel band at bottom
    canvas.setFillColor(PANEL_SOFT)
    canvas.rect(0, 0, A4[0], 30 * mm, stroke=0, fill=1)
    canvas.restoreState()


# --- Build the story ---
story = []


def P(text, style_name="body"):
    story.append(Paragraph(he(text), styles[style_name]))


def H1(text):
    story.append(Paragraph(he(text), styles["h1"]))


def H2(text):
    story.append(Paragraph(he(text), styles["h2"]))


def H3(text):
    story.append(Paragraph(he(text), styles["h3"]))


def bullets(items):
    for it in items:
        story.append(Paragraph(he("◀  ") + he(it), styles["bullet"]))


def callout(text):
    story.append(Paragraph(he(text), styles["callout"]))


def spacer(h=8):
    story.append(Spacer(1, h))


# === COVER PAGE ===
spacer(140)
story.append(Paragraph(he("TopGear"), styles["cover_title"]))
story.append(Paragraph(he("מדריך למשתמש"), styles["cover_sub"]))
story.append(Paragraph(he("מערכת ניהול מוסך — לעבודה יומיומית"), styles["cover_brass"]))
spacer(220)
story.append(Paragraph(he("גרסה 0.1.16  ·  עברית"), styles["muted"]))
story.append(PageBreak())


# === SECTION 1: שלב ראשון ===
H1("ברוך הבא ל-TopGear")
P("TopGear הוא יישום מקומי לניהול מוסך רכב — יומן עבודה, מלאי חלקים, תורים, חשבוניות והצעות מחיר. כל המידע נשמר במחשב שלך בלבד; אין שרת, אין חיבור לאינטרנט חובה, ואין מנוי חודשי.")
spacer()

H2("עיקרי המסכים")
H3("היום")
P("מסך הפתיחה. תמונת מצב יומית: הכנסות היום, רווח, מספר עבודות פתוחות, תורים, חזרות מתוכננות בקרוב והצעות מחיר ממתינות. שלושה כפתורי פעולה מהירה: + עבודה חדשה, + תור חדש, + חלק במלאי.")
H3("יומן עבודה")
P("רשימת כל העבודות. סנן לפי סטטוס (פתוחות / הצעות / נדחו / נמסרו / הכל), חפש לפי מספר רכב או שם לקוח, ולחץ על החץ ⌄ לפתיחת פרטי עבודה (ק\"מ, נפח מנוע, מחיר חלקים למוסך/ללקוח, מע\"מ, רווח, הערות, מועד חזרה מומלץ).")
H3("ניהול מלאי חלקים")
P("קטלוג חלקים מקומי עם כמויות ומחירים. בעת הוספת חלק לעבודה, המלאי יורד אוטומטית. לחץ + ליד הכמות כדי להוסיף יחידות, או − כדי להפחית. סנן לפי קטגוריה או הוסף קטגוריה חדשה שלך.")
H3("מסירות צפויות")
P("כל העבודות שעדיין לא נמסרו, ממוינות לפי דחיפות. \"באיחור\" באדום, \"היום\" בכתום, \"השבוע\" בכחול.")
H3("תורים ופגישות")
P("יומן הגעות. סמן \"הגיע\" כדי לפתוח עבודה חדשה עם פרטי הלקוח ממולאים מראש, או \"לא הגיע\" כדי להעביר את התור לטאב \"לא הגיעו\" (מבלי למחוק).")
H3("שליחה ללקוח")
P("שליחת הודעות WhatsApp ישירות מהאפליקציה — 4 תבניות מוכנות (תזכורת תור, רכב מוכן, חשבונית, תודה) עם מילוי אוטומטי של שם הלקוח, רכב ותאריך.")
H3("היסטוריית רכב")
P("לחץ על מספר רכב כלשהו בכל מסך — או הקלד ידנית — ותראה את כל הביקורים של אותו רכב, סך ההכנסה, הרווח המצטבר וק\"מ אחרון.")
H3("הגדרות")
P("פרטי העסק לחשבוניות (שם, מספר עוסק, מספר רישוי, כתובת, טלפון, אחוז מע\"מ ברירת מחדל), ייצוא נתונים ל-JSON או CSV, וייבוא מקובץ גיבוי.")
story.append(PageBreak())


# === SECTION 2: הוספת עבודה ===
H1("הוספת עבודה חדשה — שלב אחר שלב")
P("טופס העבודה מחולק לשלוש לשוניות. תוכל לעבור ביניהן בלחיצה על המספר בראש המודאל, או ב\"הבא ← / → הקודם\" בתחתית.")

H2("1. פרטים בסיסיים")
H3("פרטי הרכב")
P("התחל בהזנת מספר הרכב. ברגע שתעזוב את השדה (Tab או לחיצה במקום אחר), האפליקציה תפנה אוטומטית למאגר משרד התחבורה ותמלא את: יצרן, דגם, שנת ייצור ונפח מנוע. אם המאגר לא מצא את הרכב, תוכל למלא ידנית.")
P("בנוסף: ק\"מ ברכב — כל מספר שלם (כולל לדוגמה 65,443).")
H3("פרטי הלקוח")
P("שם, טלפון (כקישור מהיר לחיוג בעמודה ביומן), ותאריך מסירה מתוכנן (אופציונלי). תאריך המסירה מצמיד את העבודה למסך \"מסירות צפויות\" ומשנה את צבעיה לפי דחיפות.")

H2("2. חלקים ועלויות")
H3("בחירת חלקים מהמלאי")
P("בחר קטגוריה (או \"הכל\"), חפש בשם או מק\"ט, ולחץ על כרטיס החלק. הכרטיס יזוז למצב \"נבחר\" עם כפתור \"+ הוספה לעבודה\". הזן את הכמות (ברירת מחדל 1) ולחץ.")
callout("מלאי חסר: אם החלק אזל מהמלאי הכרטיס יוצג אפור. אפשר להוסיף אותו כ\"חלק זמני\" דרך \"יצירת חלק חדש\" — חלק שלא יישמר במלאי הקבוע, רק לעבודה הספציפית הזו.")
H3("הוספת חלק חדש למלאי מתוך טופס העבודה")
P("לחץ \"יצירת חלק חדש\" → פתיחת פאנל קטן בתוך הטופס. סמן \"חלק זמני\" אם החלק לא רלוונטי למלאי הקבוע. אחרת הוא יישמר במאגר המלאי וזמין לעבודות עתידיות.")
H3("מחיר עבודה ומע\"מ")
P("הזן מחיר עבודה בש\"ח (לפני מע\"מ). אם תיבת \"כלל מע\"מ בחשבון ללקוח\" מסומנת, האפליקציה תחשב אוטומטית את המע\"מ לפי האחוז שמוגדר ב\"הגדרות\" (ברירת מחדל 18%) או לפי האחוז שנקבע ספציפית לעבודה.")
H3("רצועת סיכום")
P("בתחתית הלשונית רואים בזמן אמת: עלות חלקים (למוסך), מחיר חלקים ללקוח, סה\"כ לפני מע\"מ, מע\"מ, סה\"כ לתשלום, ורווח. בלחיצה על \"שמירה\" כל הערכים הללו מקובעים לעבודה.")

H2("3. הערות ומעקב")
H3("סיכום הביקור")
P("הקלד מה נעשה, מה נמצא ומה ההמלצה ללקוח. הטקסט תומך במספר שורות, ויופיע בהיסטוריית הרכב וגם בחשבונית/הצעת המחיר כאשר תפיק PDF.")
H3("מועד מומלץ לחזרה")
P("הזן תאריך אופציונלי. כשתשמור, האפליקציה תוסיף אוטומטית תור חדש בעמוד \"תורים ופגישות\" באותו תאריך, עם פרטי הלקוח, הרכב והערות הביקור. התור יסומן בתגית \"🔁 מעקב\" כדי שתזהה שהוא נוצר אוטומטית.")
callout("עריכת תאריך החזרה בעבודה תעדכן את התור התואם בעמוד התורים. ניקוי התאריך יסיר את התור.")

H2("מצב מיוחד: עבודה / הצעת מחיר")
P("בראש המודאל יש תג גלוי עם שתי אפשרויות: \"עבודה\" (ברירת מחדל) ו\"הצעת מחיר\". לחיצה על \"הצעת מחיר\" משנה את אופי הרישום:")
bullets([
    "החלקים לא יורדים מהמלאי בעת השמירה (כי הלקוח עוד לא אישר).",
    "ההצעה מופיעה בטאב \"הצעות\" ביומן העבודה (לא ב\"פתוחות\").",
    "כפתורי הפעולה ליד השורה משתנים ל-\"✓ אשר וצור עבודה\" + \"✗ דחה\".",
    "בהדפסת PDF, המסמך נושא את הכותרת \"כרטיס עבודה / הצעת מחיר\" עם תוקף 14 יום.",
])
story.append(PageBreak())


# === SECTION 3: WORKFLOW ===
H1("מסלול הצעת מחיר → אישור")
P("הצעת מחיר היא אומדן ראשוני, לא עבודה אמיתית. תהליך טיפוסי:")
bullets([
    "פותחים עבודה במצב \"הצעת מחיר\", ממלאים פרטי רכב + חלקים + מחיר.",
    "לוחצים \"שמירה\" → ההצעה נשמרת בטאב \"הצעות\".",
    "מדפיסים את ההצעה ל-PDF (כפתור 🧾 בכרטיס הפעולות) ושולחים ללקוח.",
    "אם הלקוח אישר: לוחצים \"✓ אשר וצור עבודה\" — ההצעה הופכת לעבודה אמיתית, החלקים יורדים מהמלאי, וכותרת ה-PDF משתנה ל\"חשבונית מס\".",
    "אם הלקוח דחה: לוחצים \"✗ דחה\" — ההצעה עוברת לטאב \"נדחו\" ולא תפריע יותר. תוכל לשחזר אותה בכל עת באמצעות \"↩ החזר להצעה\" בטאב \"נדחו\".",
])

H2("מסלול תור → עבודה → מסירה")
bullets([
    "לקוח מתקשר. מוסיפים תור חדש בעמוד \"תורים ופגישות\" עם תאריך ושעה.",
    "ביום הגעת הלקוח, לוחצים \"✓ הגיע - פתח עבודה\" בשורת התור — נפתח טופס עבודה עם פרטי הלקוח והרכב כבר ממולאים.",
    "ממלאים חלקים, מחיר עבודה, ושומרים. העבודה במצב \"פתוח\".",
    "כשהעבודה מסתיימת: לוחצים \"✓ סמן כנמסר\" — העבודה עוברת לטאב \"נמסרו\" וההכנסה נכנסת לחישוב הרווח היומי.",
    "אם בטעות סימנת \"נמסר\", לחץ \"↩ החזר לפתוח\" כדי להחזיר את העבודה למצב פעיל.",
])

callout("רק עבודות שסומנו \"נמסרו\" וגם אינן הצעות מחיר נחשבות בבאנר ההכנסות/עלויות/רווח. הצעות מחיר ועבודות פתוחות אינן מנפחות את הסכומים.")
story.append(PageBreak())


# === SECTION 4: חשבוניות ===
H1("חשבונית מס והצעת מחיר — הפקת PDF")
P("מכל עבודה אפשר להפיק מסמך PDF מקצועי. לחץ על האייקון 🧾 (\"חשבונית / הצעה\") בכרטיס הפעולות של השורה.")

H2("מה צריך להגדיר לפני ההדפסה הראשונה?")
P("פתח \"הגדרות\" (אייקון גלגל-שיניים בתפריט הצדדי) ומלא את פרטי העסק:")
bullets([
    "שם העסק (לדוגמה: \"מוסך TopGear\").",
    "מספר עוסק מורשה (ע.מ. / ח.פ.) — 9 ספרות.",
    "מספר רישוי עסק (רישיון עסק / רישוי מוסך) — מופיע על החשבונית.",
    "כתובת ועיר.",
    "טלפון.",
    "אחוז מע\"מ ברירת מחדל (18%).",
])
P("לחץ \"שמור פרטי עסק\". הפרטים יופיעו על כל חשבונית והצעת מחיר.")
callout("חובה לפי חוק: כל חשבונית חייבת לכלול את שם העסק ומספר העוסק. ללא הגדרת הפרטים הללו האפליקציה תזהיר אותך לפני ההדפסה.")

H2("מה כלול במסמך ה-PDF?")
bullets([
    "כותרת: \"חשבונית מס\" / \"חשבונית\" / \"כרטיס עבודה / הצעת מחיר\" — לפי המצב.",
    "מספר חשבונית/הצעה אוטומטי.",
    "תאריכי הפקה ועבודה.",
    "פרטי העסק (כולל עוסק מורשה ומספר רישוי).",
    "פרטי הלקוח: שם, טלפון, רכב (מספר + יצרן + שנת ייצור + נפח מנוע).",
    "טבלת פירוט: כל חלק ומחירו, ובסוף שורת \"עבודה / שירות\".",
    "סיכום: סה\"כ לפני מע\"מ, מע\"מ, סה\"כ לתשלום.",
    "בלוק \"הערות ומעקב\": ק\"מ ברכב, הערות הביקור, מועד מומלץ לחזרה (אם נרשמו בעבודה).",
    "חתימת לקוח + חתימת בעל העסק (להחתמה ידנית לאחר ההדפסה).",
])

H2("שמירה כ-PDF")
P("בחלון החשבונית לחץ \"🖨 הדפס / שמור PDF\". בחר \"שמור כ-PDF\" כיעד הדפסה. שם הקובץ ממולא אוטומטית, לדוגמה: \"חשבונית_000023_123-45-678_2026-05-20.pdf\". אין צורך להקליד שם ידנית.")
story.append(PageBreak())


# === SECTION 5: WhatsApp ===
H1("שליחת הודעות WhatsApp ללקוחות")
P("האפליקציה לא משתמשת ב-API נפרד ולא דורשת חשבון WhatsApp Business. היא רק פותחת את WhatsApp Web/Desktop שלך עם הודעה מוכנה, ואתה לוחץ \"שלח\".")

H2("צעדים")
bullets([
    "פתח \"שליחה ללקוח\" בתפריט הצדדי.",
    "בחר מקור: \"מהעבודות\", \"מהתורים\", או \"הזן ידנית\".",
    "סנן או חפש את הלקוח ולחץ עליו — פרטיו (שם, רכב, תאריך/שעה) מופיעים בצד.",
    "בחר אחת מ-4 התבניות: תזכורת תור / רכב מוכן לאיסוף / חשבונית / תודה כללית.",
    "האפליקציה ממלאת את ההודעה אוטומטית. תוכל לערוך לפני שליחה.",
    "לחץ \"📱 פתח ב-WhatsApp\" — נפתח חלון WhatsApp Web עם ההודעה מוכנה. לחץ \"שלח\" וזהו.",
])
callout("ההודעות נשלחות מחשבון ה-WhatsApp האישי שלך — לא דרך שרת חיצוני, לא בעלות כספית.")
spacer()


# === SECTION 6: מלאי ===
H1("ניהול מלאי חלקים")

H2("הוספת חלק חדש למלאי")
P("בעמוד \"ניהול מלאי חלקים\" לחץ \"+ הוספת חלק\". מלא: מק\"ט (אופציונלי), שם החלק, קטגוריה, כמות במלאי, מחיר למוסך (העלות שלך), מחיר ללקוח. שמור.")

H2("עדכון כמות מהיר")
P("בכל שורת חלק יש כפתורי + ו-− לעדכון מהיר של הכמות במלאי (לדוגמה אחרי קבלת משלוח: + 10).")

H2("קטגוריות מותאמות")
P("9 קטגוריות מובנות: מנוע, פילטרים, בלמים, גיר, חשמל, מתלים, מרכב, כללי. תוכל להוסיף קטגוריות משלך (\"+ קטגוריה\" ליד פס הקטגוריות) — לדוגמה \"שמנים\", \"מצברים\", \"גומיות\".")

H2("התראת מלאי חסר")
P("ביצירת עבודה, אם בוחרים חלק שאזל מהמלאי, הכרטיס יופיע אפור עם תווית \"מלאי 0\". תוכל להוסיף כ\"חלק זמני\" דרך \"יצירת חלק חדש\" → סמן \"חלק זמני (לא יישמר במלאי, רק לעבודה זו)\".")
story.append(PageBreak())


# === SECTION 7: ניתוח עסקי ===
H1("ניתוח עסקי")
P("הבאנר בראש יומן העבודה מציג שלושה מספרים: סה\"כ הכנסות, סה\"כ עלויות, רווח נקי. ארבע אפשרויות בחירת טווח:")
bullets([
    "היום — היום הנוכחי בלבד.",
    "השבוע — 7 ימים אחורה.",
    "החודש — חודש מסוים (לחיצה פותחת בורר חודש; בחר חודש כלשהו בעבר).",
    "הכל — כל הנתונים מאז התקנת האפליקציה.",
])
callout("המספרים מחושבים רק מעבודות שסומנו \"נמסרו\" וגם אינן הצעות מחיר. עבודות פתוחות / הצעות / הצעות שנדחו לא מנפחות את הסיכום — כך שהמספרים משקפים מזומן שכבר נכנס לעסק.")

H2("היסטוריית רכב")
P("לחץ על כל מספר רכב צהוב במסך כלשהו — או הקלד ידנית בעמוד \"היסטוריית רכב\" — ותראה תמונת מצב לאותו רכב:")
bullets([
    "כל הביקורים עם תאריך, חלקים, וסה\"כ לתשלום.",
    "סה\"כ הכנסה ורווח מצטבר.",
    "מספר ביקורים, ביקור אחרון, ק\"מ אחרון, חזרה מתוכננת.",
    "פרטי בעלים: שם, טלפון, רכב.",
])
story.append(PageBreak())


# === SECTION 8: גיבוי ===
H1("גיבוי, ייצוא וייבוא נתונים")
P("מסך \"הגדרות\" מספק שלוש פעולות לשמירת הנתונים שלך:")

H2("ייצוא JSON מלא")
P("שומר את כל הנתונים (עבודות, מלאי, תורים, פרטי עסק, קטגוריות מותאמות) לקובץ אחד. השם: \"topgear-backup-תאריך.json\". השתמש לגיבוי מלא — ייבוא חוזר משחזר את האפליקציה למצב בדיוק כפי שהיה.")

H2("ייצוא יומן CSV")
P("מייצא רק את יומן העבודה כקובץ CSV הניתן לפתיחה ב-Excel. כולל עמודת \"סטטוס\" (הצעת מחיר / נמסר / פתוח / הצעה נדחתה) ותאריך מסירה בפועל — אפשר לסנן ב-Excel את \"נמסר\" ולקבל את אותם מספרים שמופיעים בבאנר ההכנסות.")

H2("ייצוא מלאי CSV")
P("מייצא רק את החלקים במלאי: מק\"ט, שם, קטגוריה, כמות, מחיר למוסך, מחיר ללקוח.")

H2("ייבוא מגיבוי")
P("שמור ראשית את הקובץ ה-JSON של הגיבוי במקום בטוח. בחר \"Choose File\" תחת \"ייבוא מגיבוי\" → אשר את ההחלפה. הייבוא יחליף את כל הנתונים הקיימים במחשב זה.")
callout("הגיבויים נשמרים במחשב שלך בלבד — לא ב\"ענן\". מומלץ להעתיק את קובץ ה-JSON ל-USB או Google Drive פעם בשבוע.")

H2("שמירת הנתונים האוטומטית")
P("האפליקציה שומרת כל שינוי באופן מיידי במחשב המקומי (IndexedDB). אין צורך ללחוץ \"שמור\" כלשהו. אם המחשב נכבה באמצע — הנתונים שכבר הוזנו נשמרו.")
story.append(PageBreak())


# === SECTION 9: עדכונים + טיפים ===
H1("עדכוני גרסה")
P("האפליקציה בודקת אוטומטית אם יש גרסה חדשה כשהיא נפתחת. אם יש — תופיע הודעה עם רשימת השינויים. לחץ \"התקן עדכון\" כדי להוריד ולהתקין ברקע — הנתונים שלך נשמרים, רק האפליקציה מתעדכנת.")
callout("העדכונים חתומים דיגיטלית. אם הודעת אבטחה כלשהי מופיעה — סגור את האפליקציה והפעל מחדש כדי שהעדכון יהיה ראוי לאמון.")

H1("טיפים שימושיים")
bullets([
    "לחיצה על מספר טלפון בעמודת \"לקוח\" — מפתיחה את חייגן ברירת המחדל.",
    "לחיצה על מספר רכב צהוב — קופצת ישירות להיסטוריית הרכב.",
    "כפתור \"↩\" משחזר כל פעולה: ↩ החזר לפתוח / ↩ בטל הגעה / ↩ החזר להצעה / ↩ החזר לצפוי. אל תפחד לסמן בטעות.",
    "תוכל לחפש כל דבר — מספר רכב, שם לקוח, טלפון או שם חלק — בתיבת החיפוש העליונה בכל מסך.",
    "בהדפסת חשבונית, ניתן להוסיף הערות ידניות אחרי השמירה (בטופס יש \"הערות ומעקב\" — תוכן זה יודפס).",
    "תורים שנוצרו אוטומטית ממועד חזרה של עבודה מסומנים ב-🔁 — אל תמחק אותם אלא אם הלקוח אמר שלא יחזור.",
])

H1("שאלות נפוצות")
H3("האם הנתונים שלי בטוחים?")
P("הנתונים נשמרים אך ורק בדפדפן (IndexedDB) של המחשב שלך. אין שליחה לשרת. אין חיבור לאינטרנט נדרש להפעלה היומית (רק לבדיקת עדכונים ולהשלמת פרטי רכב אוטומטית ממאגר משרד התחבורה).")
H3("מה קורה אם הדפדפן/המחשב נופל?")
P("הנתונים נשמרים אחרי כל פעולה. אם המחשב נכבה באמצע, כל מה שהוזן עד אותו רגע יישמר. עם זאת, מומלץ לייצא גיבוי JSON פעם בשבוע למקרה של תקלה בכונן.")
H3("האם אפשר לעבוד מכמה מחשבים?")
P("לא — האפליקציה היא מקומית. אם תרצה להעביר את העבודה למחשב אחר: ייצוא JSON ממחשב 1 → ייבוא JSON במחשב 2 (יחליף את הנתונים שם).")
H3("איך אני מוסיף עובדים?")
P("בגרסה הנוכחית אין הרשאות משתמש. כולם רואים את אותם נתונים. אם תרצה הפרדה — חשבונות Windows נפרדים יספקו הפרדה (כל משתמש Windows = IndexedDB משלו).")
H3("האפליקציה לא נפתחת או קורסת — מה לעשות?")
P("נסה להפעיל מחדש את המחשב. אם הבעיה ממשיכה: צור גיבוי (אם אפשר), הסר את האפליקציה והתקן מחדש מ-GitHub Releases. כל הנתונים יישארו (הם מאוחסנים בנפרד מהאפליקציה עצמה).")
spacer(20)
story.append(Paragraph(he("גרסה 0.1.16  ·  TopGear — מערכת ניהול מוסך"), styles["muted"]))


# --- Build ---
doc = BaseDocTemplate(
    str(OUT),
    pagesize=A4,
    leftMargin=20 * mm,
    rightMargin=20 * mm,
    topMargin=22 * mm,
    bottomMargin=18 * mm,
    title="TopGear - מדריך למשתמש",
    author="TopGear",
    subject="מדריך למשתמש - מערכת ניהול מוסך",
)

# Frame for content (RTL: text flows right-to-left within the same A4 box)
frame = Frame(
    doc.leftMargin,
    doc.bottomMargin,
    doc.width,
    doc.height,
    id="main",
    leftPadding=0,
    rightPadding=0,
    topPadding=0,
    bottomPadding=0,
)

# Two templates: cover (no header line) and body (header line + footer)
cover_template = PageTemplate(id="cover", frames=[frame], onPage=on_cover)
body_template = PageTemplate(id="body", frames=[frame], onPage=on_page)
doc.addPageTemplates([cover_template, body_template])

# Switch to body template after the first PageBreak.
# (ReportLab applies the first PageTemplate to page 1; subsequent pages
#  use the next template in the list automatically.)

doc.build(story)

print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KB)")
