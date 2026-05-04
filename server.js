import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";

dotenv.config(); // optional, for hiding tokens later

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));  // important for base64 images

const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY; // Get free key from https://ocr.space/ocrapi
const APIFY_TOKEN = process.env.APIFY_TOKEN;

// ================== OCR FUNCTION (Free) ==================
async function extractTextFromReceipt(imageBase64) {
  try {
    const formData = new URLSearchParams();
    formData.append("base64Image", `data:image/jpeg;base64,${imageBase64}`);
    formData.append("language", "rus");           // Russian
    formData.append("isOverlayRequired", "false");
    formData.append("scale", "true");
    formData.append("OCREngine", "1"); // often better for structured text
    formData.append("detectOrientation", "true");

    const response = await axios.post(
      "https://api.ocr.space/parse/image",
      formData,
      {
        headers: {
          "apikey": OCR_SPACE_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    console.log("OCR FULL RESPONSE:", response.data);

    if (response.data.IsErroredOnProcessing) {
      throw new Error(response.data.ErrorMessage || "OCR processing error");
    }

    const extractedText = response.data.ParsedResults[0].ParsedText;
    console.log("OCR RAW:", extractedText);
    return extractedText.trim();

  } catch (err) {
    console.error("OCR Error:", err.message);
    return null;
  }
};

function normalizeText(text) {
  return text
    .replace(/[^\S\r\n]+/g, ' ')   // remove extra spaces
    .replace(/[,]/g, '.')          // unify decimals
    .replace(/O/g, '0')            // OCR mistakes
    .replace(/СИРНИИ/gi, 'СЫРНЫЙ') // optional fix examples
}

// ================== SIMPLE RECEIPT PARSER ==================
function parseReceiptText(text) {
  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 3);

  const items = [];

  for (const line of lines) {
    // must contain letters AND numbers
    if (!/[a-zA-Zа-яА-Я]/.test(line)) continue;
    if (!/\d/.test(line)) continue;

    // find ALL numbers in line
    const numbers = line.match(/\d+[.,]?\d*/g);
    if (!numbers) continue;

    // take LAST number as price (important!)
    const priceRaw = numbers[numbers.length - 1];
    const price = parseFloat(priceRaw.replace(",", "."));

    if (isNaN(price)) continue;
    if (price < 5 || price > 10000) continue;

    // remove price from name
    const name = line.replace(priceRaw, "").trim();

    if (name.length < 3) continue;

    items.push({
      name,
      price: Math.round(price),
    });
  }

  return items;
}

// ================== OPTIONAL: GET CHEAPER PRICE ==================
async function getYandexPrice(query) {
  if (!query || query.length < 3) return null;

  try {
    const input = {
      query: query,
      maxItems: 6,
      region: "213",        // Moscow
    };

    const response = await axios.post(
      `https://api.apify.com/v2/acts/txUbFMvDZI1SnMzJa/runs?token=${APIFY_TOKEN}`,
      input,
      { headers: { "Content-Type": "application/json" }, timeout: 35000 }
    );

    // ... (keep your polling logic here - I shortened it for clarity)

    // For now, return null to avoid complexity. We can improve later.
    return null;

  } catch (e) {
    console.error("Yandex error:", e.message);
    return null;
  }
}

// ================== MAIN ENDPOINT ==================
app.post("/scan-receipt", async (req, res) => {
  const { imageBase64 } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ 
      success: false, 
      error: "imageBase64 is required" 
    });
  }

  try {
    console.log("Received receipt image...");

    const rawText = await extractTextFromReceipt(imageBase64);

    if (!rawText) {
      return res.json({
        success: false,
        error: "Не удалось распознать текст на чеке. Попробуйте сделать фото clearer."
      });
    }

    const cleanText = normalizeText(rawText);

    const parsed = parseReceiptText(cleanText);

    console.log("NORMALIZED TEXT:", cleanText.slice(0, 300));

    res.json({
      success: true,
      rawText: parsed.rawText,
      items: parsed.items,
      total: parsed.total,
      count: parsed.items.length
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ 
      success: false, 
      error: "Ошибка сервера при обработке чека" 
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Server is running - Receipt Scanner API" });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});