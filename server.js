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
    formData.append("OCREngine", "2");            // Better engine for receipts

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

    if (response.data.IsErroredOnProcessing) {
      throw new Error(response.data.ErrorMessage || "OCR processing error");
    }

    const extractedText = response.data.ParsedResults[0].ParsedText;
    return extractedText.trim();

  } catch (err) {
    console.error("OCR Error:", err.message);
    return null;
  }
}

// ================== SIMPLE RECEIPT PARSER ==================
function parseReceiptText(text) {
  if (!text) return [];

  const lines = text.split("\n").map(line => line.trim()).filter(line => line.length > 3);

  const items = [];
  const priceRegex = /(\d+[.,]\d{2}|\d+)\s*₽?$/;   // looks for prices at the end of line

  for (const line of lines) {
    const priceMatch = line.match(priceRegex);
    if (priceMatch) {
      let priceStr = priceMatch[0].replace(/[.,]00$/, "").replace(/[^0-9.,]/g, "");
      let price = parseFloat(priceStr.replace(",", "."));

      if (price > 1 && price < 100000) {
        // Remove price from the name
        const name = line.replace(priceMatch[0], "").trim();
        if (name.length > 2) {
          items.push({
            originalText: line,
            name: name,
            price: Math.round(price),
            quantity: 1   // we can improve this later
          });
        }
      }
    }
  }

  // Try to detect total
  let total = null;
  const totalMatch = text.match(/итого|всего|сумма|total[:\s]*(\d+[.,]\d{2})/i);
  if (totalMatch) {
    total = parseFloat(totalMatch[1].replace(",", "."));
  }

  return {
    items,
    total: total || null,
    rawText: text,
    itemCount: items.length
  };
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

    const parsed = parseReceiptText(rawText);

    console.log(`Parsed ${parsed.items.length} items from receipt`);

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