import React, { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

// Helper to get a cookie value
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(";").shift();
}

function FormWithRecorder() {
  const { formId } = useParams();
  const [formStructure, setFormStructure] = useState(null);
  const [error, setError] = useState(null);
  const [realtimeAttributes, setRealtimeAttributes] = useState({});
  const [isRecording, setIsRecording] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [formValues, setFormValues] = useState({});
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const finalResultsReceivedRef = useRef(false);
  const streamRef = useRef(null);
  const formRef = useRef(null);

  // Load form structure from your API
  useEffect(() => {
    const fetchForm = async () => {
      try {
        const response = await fetch(
          `https://formify-yg3d.onrender.com/api/auth/forms/${formId}/`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Token ${getCookie("auth_token")}`,
            },
          }
        );
        if (!response.ok) throw new Error("Failed to fetch form details");
        const data = await response.json();
        setFormStructure(data);

        // Initialize form values
        const initialValues = {};
        data.blocks.forEach((block) => {
          block.fields.forEach((field) => {
            initialValues[field.field_name] = field.value || "";
          });
        });
        setFormValues(initialValues);
      } catch (err) {
        console.error(err);
        setError(err.message);
      }
    };
    fetchForm();
  }, [formId]);

  // WebSocket connection setup
  useEffect(() => {
    const socket = new WebSocket(
      `wss://formify-yg3d.onrender.com/ws/transcription/${formId}/`
    );
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      console.log("WebSocket connected");
    };
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log("WebSocket data received:", data);

        // If final results have already been received, ignore further messages.
        if (finalResultsReceivedRef.current) {
          console.log("Final results already processed. Ignoring message.");
          return;
        }

        // Check if this is the final result.
        if (data.final_results) {
          console.log("Received final verified results:", data.attributes);
          setRealtimeAttributes(data.attributes);
          setFormValues((prev) => ({ ...prev, ...data.attributes }));
          // Set the flag so that future messages are ignored.
          finalResultsReceivedRef.current = true;
        } else if (data.attributes) {
          // Process intermediate messages.
          setRealtimeAttributes((prev) => ({ ...prev, ...data.attributes }));
          setFormValues((prev) => ({ ...prev, ...data.attributes }));
        }
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    };
    socket.onclose = () => {
      console.log("WebSocket closed");
    };
    socket.onerror = (err) => {
      console.error("WebSocket error:", err);
    };
    wsRef.current = socket;
    return () => {
      socket.close();
    };
  }, []);

  // Recording functions
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
      streamRef.current = stream;
      const options = { mimeType: "audio/webm; codecs=opus" };
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = async (event) => {
        if (
          event.data &&
          event.data.size > 0 &&
          wsRef.current &&
          wsRef.current.readyState === WebSocket.OPEN
        ) {
          const arrayBuffer = await event.data.arrayBuffer();
          wsRef.current.send(arrayBuffer);
          console.log(`Sent ${arrayBuffer.byteLength} bytes`);
        }
      };
      recorder.start(1000);
      setIsRecording(true);
    } catch (err) {
      console.error("Error starting recording:", err);
      setError("Failed to access microphone");
    }
  };

  const stopRecording = () => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
      streamRef.current.getTracks().forEach((track) => track.stop());

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "stop_recording" }));
        console.log("Sent stop_recording action");
      }
      setIsRecording(false);
    }
  };

  // Form handling
  const handleInputChange = (fieldName, value) => {
    setFormValues((prev) => ({
      ...prev,
      [fieldName]: value,
    }));
  };

  const saveFormData = async () => {
    try {
      // Implementation for saving form data to your backend would go here
      console.log("Form data to save:", formValues);
      setIsEditing(false);
    } catch (err) {
      console.error("Error saving form data:", err);
      setError("Failed to save form data");
    }
  };

  // Improved PDF export function
  const exportToPdf = async () => {
    if (!formRef.current) return;

    setIsGeneratingPdf(true);

    try {
      // Create a temporary div to use for PDF generation
      const pdfContainer = document.createElement("div");
      pdfContainer.style.position = "absolute";
      pdfContainer.style.left = "-9999px";
      pdfContainer.style.width = "210mm"; // A4 width

      // Clone the form for PDF generation
      const clone = formRef.current.cloneNode(true);

      // Override some styles for better PDF output
      const style = document.createElement("style");
      style.textContent = `
        * {
          font-family: 'Arial', sans-serif;
          box-sizing: border-box;
        }
        .form-container {
          padding: 20px;
          background-color: white;
          border-radius: 0;
          box-shadow: none;
          border: none;
        }
        .form-header {
          margin-bottom: 20px;
          padding-bottom: 10px;
          border-bottom: 1px solid #e5e7eb;
        }
        .form-title {
          font-size: 24px;
          font-weight: bold;
          color: #111827;
          margin: 0;
        }
        .block-container {
          margin-bottom: 20px;
        }
        .block-title {
          font-size: 18px;
          font-weight: bold;
          margin-bottom: 10px;
          padding-bottom: 5px;
          border-bottom: 1px solid #e5e7eb;
        }
        .field-container {
          margin-bottom: 10px;
        }
        .field-label {
          font-weight: 500;
          margin-bottom: 4px;
        }
        .field-value {
          padding: 8px;
          border: 1px solid #d1d5db;
          border-radius: 4px;
          background-color: #f9fafb;
          min-height: 24px;
        }
      `;

      // Create a styled version of the form
      const styledForm = document.createElement("div");
      styledForm.className = "form-container";

      // Add header
      const header = document.createElement("div");
      header.className = "form-header";
      const title = document.createElement("h1");
      title.className = "form-title";
      title.textContent = formStructure.form_name;
      header.appendChild(title);
      styledForm.appendChild(header);

      // Add blocks and fields
      formStructure.blocks.forEach((block) => {
        const blockDiv = document.createElement("div");
        blockDiv.className = "block-container";

        const blockTitle = document.createElement("h2");
        blockTitle.className = "block-title";
        blockTitle.textContent = block.block_name;
        blockDiv.appendChild(blockTitle);

        block.fields.forEach((field) => {
          const fieldDiv = document.createElement("div");
          fieldDiv.className = "field-container";

          const fieldLabel = document.createElement("div");
          fieldLabel.className = "field-label";
          fieldLabel.textContent = field.field_name + ":";
          fieldDiv.appendChild(fieldLabel);

          const fieldValue = document.createElement("div");
          fieldValue.className = "field-value";
          fieldValue.textContent = formValues[field.field_name] || "";
          fieldDiv.appendChild(fieldValue);

          blockDiv.appendChild(fieldDiv);
        });

        styledForm.appendChild(blockDiv);
      });

      pdfContainer.appendChild(style);
      pdfContainer.appendChild(styledForm);
      document.body.appendChild(pdfContainer);

      // Generate PDF using html2canvas and jsPDF
      const canvas = await html2canvas(styledForm, {
        scale: 2,
        logging: false,
        useCORS: true,
      });

      const imgData = canvas.toDataURL("image/png");

      // A4 dimensions in mm: 210 x 297
      const pdf = new jsPDF({
        unit: "mm",
        format: "a4",
        orientation: "portrait",
      });

      // Calculate the dimensions
      const imgWidth = 210; // A4 width in mm minus margins
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      // Add image to PDF (with 10mm margins on each side)
      pdf.addImage(imgData, "PNG", 0, 0, imgWidth, imgHeight);

      // If content is longer than one page, add more pages
      let heightLeft = imgHeight;
      let position = 0;

      while (heightLeft > 297) {
        // A4 height
        position = position - 297;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= 297;
      }

      // Save the PDF
      pdf.save(`${formStructure?.form_name || "form"}.pdf`);

      // Clean up
      document.body.removeChild(pdfContainer);
    } catch (err) {
      console.error("Error generating PDF:", err);
      setError("Failed to generate PDF");
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  // Form structure processing
  const getFilledFormStructure = () => {
    if (!formStructure || !formStructure.blocks) return null;
    const updatedBlocks = formStructure.blocks.map((block) => {
      const updatedFields = block.fields.map((field) => {
        return {
          ...field,
          value: formValues[field.field_name] || "",
        };
      });
      return { ...block, fields: updatedFields };
    });
    return { ...formStructure, blocks: updatedBlocks };
  };

  const filledForm = getFilledFormStructure();

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {error && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 mb-6 rounded-md">
          <div className="flex items-center">
            <svg
              className="h-5 w-5 text-red-500 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="text-red-700">{error}</p>
          </div>
        </div>
      )}

      {!formStructure ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-pulse flex space-x-4">
            <div className="flex-1 space-y-4 py-1">
              <div className="h-4 bg-gray-200 rounded w-3/4"></div>
              <div className="space-y-2">
                <div className="h-4 bg-gray-200 rounded"></div>
                <div className="h-4 bg-gray-200 rounded w-5/6"></div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <header className="mb-8">
            <h1 className="text-3xl font-bold text-gray-800">
              {formStructure.form_name}
            </h1>
            <p className="text-gray-500 mt-2">
              Fill this form using voice recording or manual editing
            </p>
          </header>

          <div className="mb-8 flex flex-wrap gap-4">
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm flex items-center transition-colors duration-200"
                disabled={isEditing}
              >
                <svg
                  className="h-5 w-5 mr-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                  />
                </svg>
                Start Recording
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-sm flex items-center transition-colors duration-200 animate-pulse"
              >
                <svg
                  className="h-5 w-5 mr-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
                  />
                </svg>
                Stop Recording
              </button>
            )}

            {!isEditing ? (
              <button
                onClick={() => setIsEditing(true)}
                className="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg shadow-sm flex items-center transition-colors duration-200"
                disabled={isRecording}
              >
                <svg
                  className="h-5 w-5 mr-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
                Edit Form
              </button>
            ) : (
              <button
                onClick={saveFormData}
                className="px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg shadow-sm flex items-center transition-colors duration-200"
              >
                <svg
                  className="h-5 w-5 mr-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Save Changes
              </button>
            )}

            <button
              onClick={exportToPdf}
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg shadow-sm flex items-center transition-colors duration-200"
              disabled={isRecording || isEditing}
            >
              <svg
                className="h-5 w-5 mr-2"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Save as PDF
            </button>
          </div>

          <div
            ref={formRef}
            className="bg-white rounded-xl shadow-lg p-8 border border-gray-100"
          >
            <h2 className="text-xl font-semibold mb-6 text-gray-800 flex items-center">
              <svg
                className="h-5 w-5 mr-2 text-blue-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              Form Details
            </h2>
            {filledForm && filledForm.blocks && filledForm.blocks.length > 0 ? (
              filledForm.blocks.map((block, blockIndex) => (
                <div key={blockIndex} className="mb-8 last:mb-0">
                  <h3 className="text-lg font-bold mb-4 pb-2 border-b border-gray-100 text-gray-700">
                    {block.block_name}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {block.fields.map((field, fieldIndex) => (
                      <div key={fieldIndex} className="mb-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          {field.field_name}:
                        </label>
                        <input
                          type="text"
                          className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200"
                          value={formValues[field.field_name] || ""}
                          onChange={(e) =>
                            handleInputChange(field.field_name, e.target.value)
                          }
                          disabled={!isEditing && !isRecording}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-8">
                <svg
                  className="h-12 w-12 mx-auto text-gray-300 mb-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <p className="text-gray-500">No form fields found.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default FormWithRecorder;
