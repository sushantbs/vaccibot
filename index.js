const puppeteer = require("puppeteer");
const prompts = require("prompts");
const { format } = require("date-fns");
const addDays = require("date-fns/addDays");

(async () => {
  const { phoneNo } = await prompts([
    {
      type: "string",
      name: "phoneNo",
      message: "Enter a phone number that will receive the OTP",
    },
  ]);
  let page, browser, availableSession;

  const findAvailableSession = async (beneficiaries) => {
    let appointmentData;
    try {
      appointmentData = await page.evaluate(async () => {
        const token = sessionStorage.getItem("userToken");

        const responses = await Promise.all([
          fetch(
            `https://cdn-api.co-vin.in/api/v2/appointment/sessions/calendarByDistrict?district_id=294&date=${format(
              addDays(new Date(), 1),
              "dd-MM-yyyy"
            )}`,
            {
              headers: {
                accept: "application/json, text/plain, */*",
                authorization: `Bearer ${token.substring(1, token.length - 1)}`,
              },
              body: null,
              method: "GET",
              mode: "cors",
              withCredentials: true,
            }
          ),
          fetch(
            `https://cdn-api.co-vin.in/api/v2/appointment/sessions/calendarByDistrict?district_id=294&date=${format(
              addDays(new Date(), 7),
              "dd-MM-yyyy"
            )}`,
            {
              headers: {
                accept: "application/json, text/plain, */*",
                authorization: `Bearer ${token.substring(1, token.length - 1)}`,
              },
              body: null,
              method: "GET",
              mode: "cors",
              withCredentials: true,
            }
          ),
        ]);

        const responseArr = await Promise.all(
          responses.map((res) => res.json())
        );

        return responseArr.reduce(
          (mergedArr, res) => [...mergedArr, ...res.centers],
          []
        );
      });
    } catch (err) {
      console.log(err);
      startVacbot();
    }

    const slotData = appointmentData.reduce(
      (flatArray, healthCentre) => [
        ...flatArray,
        ...healthCentre.sessions.map((session) => ({
          ...session,
          center_id: healthCentre.center_id,
        })),
      ],
      []
    );

    const availableSlots = slotData
      .filter(
        (slot) =>
          slot.min_age_limit < 45 &&
          slot.available_capacity >= beneficiaries.length
      )
      .sort(
        (slotA, slotB) => slotB.available_capacity - slotA.available_capacity
      );

    if (!availableSlots.length) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return findAvailableSession(beneficiaries);
    }

    return availableSlots;
  };

  const startVacbot = async () => {
    if (browser) {
      await browser.close();
    }

    browser = await puppeteer.launch({ headless: false });
    page = await browser.newPage();
    await page.goto("https://selfregistration.cowin.gov.in/", {
      waitUntil: "networkidle2",
    });

    page.setDefaultTimeout(180000);
    page.on("pageerror", (err) => {
      console.log("PAGE ERROR: ", err.toString());
    });

    // Enter mobile number
    const mobileNumberInput = await page.$("[formcontrolname='mobile_number']");
    await mobileNumberInput.type(phoneNo);

    // Click Get OTP Button
    const getOTPButton = await page.$("ion-button");
    await getOTPButton.click();

    // Wait for OTP to be entered
    await page.waitForSelector("[formcontrolname='otp']");
    await page.waitForFunction(() => {
      const otpField = document.querySelector("[formcontrolname='otp']");
      return otpField.value && otpField.value.length === 6;
    });

    // Verify OTP
    const verifyOTPButton = await page.$("ion-button");
    await verifyOTPButton.click();

    // Wait for page to redirect to /dashboard
    await page.waitForSelector("ion-row.dose-data a");

    const beneficiariesData = await page.evaluate(async () => {
      try {
        const token = sessionStorage.getItem("userToken");
        const response = await fetch(
          "https://cdn-api.co-vin.in/api/v2/appointment/beneficiaries",
          {
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              authorization: `Bearer ${token.substring(1, token.length - 1)}`,
            },
            body: null,
            method: "GET",
            mode: "cors",
            withCredentials: true,
          }
        );

        return response.json();
      } catch (err) {
        console.error(err);
      }
    });

    const beneficiaries = beneficiariesData.beneficiaries;
    availableSession = (await findAvailableSession(beneficiaries))[0];

    // render captcha and make request to book
    await page.evaluate(async () => {
      try {
        const token = sessionStorage.getItem("userToken");
        const captchaResponse = await fetch(
          "https://cdn-api.co-vin.in/api/v2/auth/getRecaptcha",
          {
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token.substring(1, token.length - 1)}`,
            },
            body: "{}",
            method: "POST",
            mode: "cors",
            withCredentials: true,
          }
        );

        const captchaJSON = await captchaResponse.json();

        const captchaContainer = document.createElement("div");
        captchaContainer.style.padding = "20px";
        captchaContainer.style.backgroundColor = "green";
        captchaContainer.style.position = "absolute";

        const captchaImage = document.createElement("span");
        captchaImage.innerHTML = captchaJSON.captcha;
        captchaContainer.appendChild(captchaImage);

        const captchaText = document.createElement("input");
        captchaText.id = "vacbot-captcha-text";
        captchaContainer.appendChild(captchaText);

        document.body.appendChild(captchaContainer);

        const audio = new Audio();
        audio.src =
          "https://audio-previews.elements.envatousercontent.com/files/286545509/preview.mp3";
        audio.play();
      } catch (err) {
        console.error(err);
      }
    });

    await page.waitForFunction(
      () => document.getElementById("vacbot-captcha-text").value.length === 5
    );

    await page.evaluate(
      async (requestBody) => {
        try {
          const token = sessionStorage.getItem("userToken");
          await fetch("https://cdn-api.co-vin.in/api/v2/appointment/schedule", {
            headers: {
              accept: "application/json, text/plain, */*",
              "content-type": "application/json",
              authorization: `Bearer ${token.substring(1, token.length - 1)}`,
            },
            body: JSON.stringify({
              ...requestBody,
              captcha: document.getElementById("vacbot-captcha-text").value,
            }),
            method: "POST",
            mode: "cors",
          });
        } catch (err) {
          console.log("Error in scheduling: ", err);
        }
      },
      {
        center_id: availableSession.center_id,
        session_id: availableSession.session_id,
        beneficiaries: beneficiaries.map((b) => b.beneficiary_reference_id),
        slot: availableSession.slots[1],
        dose: 1,
      }
    );
  };

  await startVacbot();
})();
