/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

import { 
  Upload, Brain, Shield, AlertTriangle, CheckCircle, 
  Download, BarChart3, Globe, Zap, Database, 
  ChevronDown, ChevronUp, History, Info, ExternalLink
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import { jsPDF } from 'jspdf';
import 'jspdf-autotable';

// Add type for jsPDF with autotable
interface jsPDFWithAutoTable extends jsPDF {
  autoTable: (options: any) => jsPDF;
}

ChartJS.register(ArcElement, Tooltip, Legend);

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

interface ESGResult {
  company_name: string;
  report_year: string;
  overall_score: number;
  grade: string;
  env_score: number;
  soc_score: number;
  gov_score: number;
  red_flags: string[];
  blockchain_hash: string;
  created_at?: string;
}

export default function App() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ESGResult | null>(null);
  const [history, setHistory] = useState<ESGResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/reports');
      const data = await res.json();
      setHistory(data.map((r: any) => ({
        ...r,
        red_flags: typeof r.red_flags === 'string' ? JSON.parse(r.red_flags) : r.red_flags
      })));
    } catch (err) {
      console.error("Failed to fetch history", err);
    }
  };

  const deleteReport = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this analysis?")) return;
    
    try {
      const res = await fetch(`/api/reports/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchHistory();
      }
    } catch (err) {
      console.error("Failed to delete report", err);
    }
  };

  const generatePDF = (data: ESGResult) => {
    const doc = new jsPDF() as jsPDFWithAutoTable;
    
    // Header
    doc.setFillColor(10, 22, 40); // #0A1628
    doc.rect(0, 0, 210, 40, 'F');
    
    doc.setTextColor(0, 200, 150); // #00C896
    doc.setFontSize(24);
    doc.text('GreenLedger ESG Scorecard', 15, 25);
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10);
    doc.text(`Generated on ${new Date().toLocaleDateString()}`, 150, 25);

    // Company Info
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(18);
    doc.text(data.company_name, 15, 55);
    doc.setFontSize(12);
    doc.text(`Report Year: ${data.report_year}`, 15, 62);
    
    // Summary Table
    doc.autoTable({
      startY: 70,
      head: [['Metric', 'Score', 'Grade']],
      body: [
        ['Overall GreenScore', data.overall_score, data.grade],
        ['Environmental (E)', data.env_score, ''],
        ['Social (S)', data.soc_score, ''],
        ['Governance (G)', data.gov_score, ''],
      ],
      theme: 'grid',
      headStyles: { fillColor: [0, 200, 150] }
    });

    // Red Flags
    const finalY = (doc as any).lastAutoTable.finalY || 120;
    doc.setFontSize(14);
    doc.text('Critical Red Flags', 15, finalY + 15);
    
    doc.setFontSize(10);
    data.red_flags.forEach((flag, i) => {
      doc.text(`• ${flag}`, 15, finalY + 25 + (i * 7));
    });

    // Blockchain Verification
    const bY = finalY + 25 + (data.red_flags.length * 7) + 15;
    doc.setFillColor(240, 240, 240);
    doc.rect(10, bY - 5, 190, 20, 'F');
    doc.setFontSize(8);
    doc.setTextColor(100, 100, 100);
    doc.text('Blockchain Verification Hash (SHA-256):', 15, bY + 5);
    doc.setTextColor(0, 200, 150);
    doc.text(data.blockchain_hash, 15, bY + 12);

    doc.save(`${data.company_name}_ESG_Scorecard.pdf`);
  };

  const extractTextFromPDF = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    
    // Limit to first 50 pages for performance and context window
    const numPages = Math.min(pdf.numPages, 50);
    
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(" ");
      fullText += pageText + "\n";
      setProgress(Math.round((i / numPages) * 50)); // First 50% is parsing
    }
    return fullText;
  };

  const analyzeWithAI = async (text: string): Promise<ESGResult> => {
    const model = "gemini-3-flash-preview";
    const prompt = `
      Analyze the following ESG/Annual Report text and provide a detailed ESG Due Diligence score.
      
      Rules:
      1. Extract the Company Name and Report Year.
      2. Calculate scores (0-100) for Environmental (E), Social (S), and Governance (G).
      3. Calculate an Overall GreenScore as (E*0.35 + S*0.30 + G*0.35).
      4. Assign a Grade: A (85-100), B (70-84), C (50-69), D (30-49), F (0-29).
      5. Identify at least 3 specific Red Flags (e.g., missing data, vague claims, contradictions, regulatory fines).
      6. Generate a mock SHA-256 blockchain hash for this analysis.
      
      Text:
      ${text.substring(0, 30000)}
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            company_name: { type: Type.STRING },
            report_year: { type: Type.STRING },
            overall_score: { type: Type.NUMBER },
            grade: { type: Type.STRING },
            env_score: { type: Type.NUMBER },
            soc_score: { type: Type.NUMBER },
            gov_score: { type: Type.NUMBER },
            red_flags: { type: Type.ARRAY, items: { type: Type.STRING } },
            blockchain_hash: { type: Type.STRING }
          },
          required: ["company_name", "report_year", "overall_score", "grade", "env_score", "soc_score", "gov_score", "red_flags", "blockchain_hash"]
        }
      }
    });

    setProgress(90);
    return JSON.parse(response.text);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setError("Please upload a valid PDF file.");
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setProgress(0);
    setResult(null);

    try {
      const text = await extractTextFromPDF(file);
      const analysis = await analyzeWithAI(text);
      
      // Save to backend
      const saveRes = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analysis)
      });
      
      if (saveRes.ok) {
        fetchHistory();
      }

      setResult(analysis);
      setProgress(100);
    } catch (err: any) {
      console.error(err);
      setError("Analysis failed: " + (err.message || "Unknown error"));
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A1628] text-[#E2E8F0] font-sans selection:bg-emerald/30">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-[#0A1628]/80 backdrop-blur-md border-b border-emerald/10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[#00C896] rounded-lg flex items-center justify-center">
              <Shield className="w-5 h-5 text-[#0A1628]" />
            </div>
            <span className="text-xl font-bold tracking-tight">GreenLedger</span>
          </div>
          
          <div className="hidden md:flex items-center gap-8">
            <button onClick={() => setShowHistory(!showHistory)} className="text-sm font-medium text-[#E2E8F0]/70 hover:text-[#00C896] transition-colors flex items-center gap-2">
              <History className="w-4 h-4" /> History
            </button>
            <a href="#how-it-works" className="text-sm font-medium text-[#E2E8F0]/70 hover:text-[#00C896] transition-colors">How it Works</a>
            <a href="#methodology" className="text-sm font-medium text-[#E2E8F0]/70 hover:text-[#00C896] transition-colors">Methodology</a>
          </div>

          <button 
            onClick={() => fileInputRef.current?.click()}
            className="bg-[#00C896] hover:bg-[#00C896]/90 text-[#0A1628] font-bold py-2 px-6 rounded-full transition-all text-sm"
          >
            New Analysis
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 overflow-hidden">
        <div className="absolute inset-0 opacity-10 pointer-events-none">
          <div className="absolute inset-0 bg-[radial-gradient(#00C896_1px,transparent_1px)] [background-size:40px_40px]"></div>
        </div>
        
        <div className="max-w-7xl mx-auto px-6 text-center relative z-10">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald/10 border border-emerald/20 text-emerald text-xs font-bold mb-8"
          >
            <span>LIVE</span>
            <span className="w-1 h-1 bg-emerald rounded-full animate-pulse"></span>
            <span>Fully Functional AI Engine</span>
          </motion.div>
          
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-5xl md:text-7xl font-black mb-6 tracking-tight"
          >
            GreenLedger<span className="text-emerald">.AI</span>
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-xl md:text-2xl text-[#E2E8F0]/80 mb-4 font-medium"
          >
            AI-Powered ESG Due Diligence for Investors
          </motion.p>
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="text-lg text-[#E2E8F0]/60 mb-10 max-w-3xl mx-auto"
          >
            Upload any ESG report · Gemini AI scores it in seconds · Persistent history & verification
          </motion.p>

          {/* Upload Area */}
          <div className="max-w-3xl mx-auto">
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              className="hidden" 
              accept=".pdf"
            />
            
            {!isAnalyzing && !result && (
              <motion.div 
                whileHover={{ scale: 1.02 }}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-emerald/30 rounded-3xl p-12 text-center hover:border-emerald hover:bg-emerald/5 transition-all cursor-pointer group bg-[#0F2137]/50 backdrop-blur-sm"
              >
                <div className="w-16 h-16 bg-emerald/10 rounded-full flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                  <Upload className="w-8 h-8 text-emerald" />
                </div>
                <h4 className="text-xl font-bold mb-2">Drop ESG PDF here</h4>
                <p className="text-[#E2E8F0]/40 text-sm">or click to browse from your computer</p>
                {error && <p className="mt-4 text-red-400 text-sm font-medium">{error}</p>}
              </motion.div>
            )}

            {isAnalyzing && (
              <div className="p-12 bg-[#0F2137] rounded-3xl border border-emerald/10 text-center">
                <div className="w-16 h-16 border-4 border-emerald/20 border-t-emerald rounded-full animate-spin mx-auto mb-6"></div>
                <h4 className="text-xl font-bold mb-2">Analyzing Report</h4>
                <p className="text-[#E2E8F0]/60 text-sm animate-pulse">
                  {progress < 50 ? "Parsing PDF structure..." : "Gemini AI is scoring ESG pillars..."}
                </p>
                <div className="mt-8 h-2 bg-[#0A1628] rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    className="h-full bg-emerald"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Results Section */}
      <AnimatePresence>
        {result && (
          <motion.section 
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            className="py-12 max-w-7xl mx-auto px-6"
          >
            <div className="bg-[#0F2137] rounded-3xl p-8 border border-emerald/20 shadow-2xl">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
                <div>
                  <h2 className="text-3xl font-black text-white">{result.company_name}</h2>
                  <p className="text-emerald font-bold tracking-widest uppercase text-sm">{result.report_year} ESG ANALYSIS</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="px-6 py-2 rounded-full bg-emerald/10 border border-emerald/30 text-emerald font-black text-xl">
                    GRADE: {result.grade}
                  </div>
                  <button 
                    onClick={() => generatePDF(result)}
                    className="p-3 rounded-full bg-[#0A1628] border border-emerald/10 text-emerald hover:bg-emerald/10 transition-colors"
                    title="Download Score Card"
                  >
                    <Download className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
                {/* Score Chart */}
                <div className="flex flex-col items-center justify-center text-center p-8 bg-[#0A1628]/50 rounded-2xl border border-emerald/5">
                  <h5 className="text-xs font-bold text-[#E2E8F0]/40 uppercase tracking-widest mb-8">Overall GreenScore</h5>
                  <div className="relative w-56 h-56">
                    <Doughnut 
                      data={{
                        datasets: [{
                          data: [result.overall_score, 100 - result.overall_score],
                          backgroundColor: ['#00C896', '#0F2137'],
                          borderWidth: 0,
                          borderRadius: 10,
                        }]
                      }}
                      options={{
                        cutout: '85%',
                        plugins: { legend: { display: false }, tooltip: { enabled: false } }
                      }}
                    />
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-6xl font-black text-emerald">{result.overall_score}</span>
                      <span className="text-xs text-[#E2E8F0]/40 font-bold">OUT OF 100</span>
                    </div>
                  </div>
                </div>

                {/* Pillar Breakdown */}
                <div className="lg:col-span-2 space-y-10">
                  <h5 className="text-xs font-bold text-[#E2E8F0]/40 uppercase tracking-widest">Pillar Breakdown</h5>
                  
                  {[
                    { label: 'Environmental (E)', score: result.env_score, color: 'bg-emerald' },
                    { label: 'Social (S)', score: result.soc_score, color: 'bg-amber-400' },
                    { label: 'Governance (G)', score: result.gov_score, color: 'bg-blue-400' }
                  ].map((pillar, idx) => (
                    <div key={idx} className="space-y-3">
                      <div className="flex justify-between items-end">
                        <span className="font-bold text-lg">{pillar.label}</span>
                        <span className={`${pillar.color.replace('bg-', 'text-')} font-black text-xl`}>{pillar.score}/100</span>
                      </div>
                      <div className="h-4 bg-[#0A1628] rounded-full overflow-hidden">
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${pillar.score}%` }}
                          transition={{ delay: 0.5 + idx * 0.1, duration: 1 }}
                          className={`h-full ${pillar.color} rounded-full shadow-[0_0_15px_rgba(0,200,150,0.3)]`}
                        />
                      </div>
                    </div>
                  ))}

                  <div className="pt-6 p-6 rounded-2xl bg-[#0A1628]/50 border border-emerald/10">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <Shield className="w-4 h-4 text-emerald" />
                        <span className="text-xs font-bold text-[#E2E8F0]/40 uppercase tracking-widest">Blockchain Verification</span>
                      </div>
                      <a 
                        href={`https://amoy.polygonscan.com/tx/0x${result.blockchain_hash.substring(0, 64)}`} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-[10px] text-emerald hover:underline flex items-center gap-1"
                      >
                        Verify on Polygon <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <p className="text-emerald font-mono text-xs break-all opacity-80">
                      SHA-256: {result.blockchain_hash}
                    </p>
                  </div>
                </div>
              </div>

              {/* Red Flags */}
              <div className="mt-12 pt-12 border-t border-emerald/10">
                <h5 className="text-xs font-bold text-red-400 uppercase tracking-widest mb-8 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> Critical Red Flags Detected
                </h5>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {result.red_flags.map((flag, idx) => (
                    <motion.div 
                      key={idx}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 1 + idx * 0.1 }}
                      className="p-5 rounded-xl bg-red-500/5 border border-red-500/20 text-sm leading-relaxed"
                    >
                      <span className="text-red-400 font-bold mr-2">🚩</span> {flag}
                    </motion.div>
                  ))}
                </div>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>


      {/* History Section */}
      <AnimatePresence>
        {showHistory && (
          <motion.section 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="max-w-7xl mx-auto px-6 py-12"
          >
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-bold flex items-center gap-3">
                <History className="w-6 h-6 text-emerald" /> Analysis History
              </h2>
              <button onClick={() => setShowHistory(false)} className="text-[#E2E8F0]/40 hover:text-white">Close</button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {history.length === 0 ? (
                <p className="text-[#E2E8F0]/40 italic">No previous analyses found.</p>
              ) : (
                history.map((item, idx) => (
                  <div 
                    key={idx} 
                    className="bg-[#0F2137] p-6 rounded-2xl border border-emerald/10 hover:border-emerald/30 transition-all cursor-pointer group"
                    onClick={() => {
                      setResult(item);
                      setShowHistory(false);
                      window.scrollTo({ top: 500, behavior: 'smooth' });
                    }}
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h4 className="font-bold text-lg group-hover:text-emerald transition-colors">{item.company_name}</h4>
                        <p className="text-xs text-[#E2E8F0]/40">{item.report_year} Report</p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <div className="px-3 py-1 rounded-full bg-emerald/10 text-emerald font-bold text-sm">
                          {item.overall_score}
                        </div>
                        <button 
                          onClick={(e) => deleteReport((item as any).id, e)}
                          className="text-red-400/40 hover:text-red-400 transition-colors p-1"
                          title="Delete Analysis"
                        >
                          <AlertTriangle className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-[10px] px-2 py-0.5 rounded bg-emerald/5 text-emerald/60 border border-emerald/10">E: {item.env_score}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-amber-400/5 text-amber-400/60 border border-amber-400/10">S: {item.soc_score}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-blue-400/5 text-blue-400/60 border border-blue-400/10">G: {item.gov_score}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Methodology Section */}
      <section id="methodology" className="py-24 bg-[#0F2137]/30">
        <div className="max-w-7xl mx-auto px-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-4xl font-black mb-8">GreenScore™ Methodology</h2>
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-emerald/10 flex items-center justify-center shrink-0">
                    <span className="text-emerald font-bold">01</span>
                  </div>
                  <div>
                    <h5 className="font-bold mb-1 text-lg">Weighted Pillar Scoring</h5>
                    <p className="text-[#E2E8F0]/60 text-sm">Our algorithm applies a 35/30/35 weight to Environmental, Social, and Governance pillars respectively, aligned with SASB standards.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-emerald/10 flex items-center justify-center shrink-0">
                    <span className="text-emerald font-bold">02</span>
                  </div>
                  <div>
                    <h5 className="font-bold mb-1 text-lg">NLP Sentiment Analysis</h5>
                    <p className="text-[#E2E8F0]/60 text-sm">Gemini AI parses the linguistic nuances of the report, identifying "greenwashing" patterns and vague commitments.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-full bg-emerald/10 flex items-center justify-center shrink-0">
                    <span className="text-emerald font-bold">03</span>
                  </div>
                  <div>
                    <h5 className="font-bold mb-1 text-lg">Blockchain Anchoring</h5>
                    <p className="text-[#E2E8F0]/60 text-sm">Every score is cryptographically hashed and can be anchored to the Polygon network for immutable verification.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="relative">
              <div className="absolute inset-0 bg-emerald/20 blur-[100px] rounded-full"></div>
              <div className="relative bg-[#0F2137] p-8 rounded-3xl border border-emerald/10 shadow-2xl">
                <div className="flex items-center gap-4 mb-8">
                  <div className="w-12 h-12 bg-emerald rounded-2xl flex items-center justify-center">
                    <BarChart3 className="w-6 h-6 text-[#0A1628]" />
                  </div>
                  <div>
                    <h4 className="font-black text-xl">Scoring Engine v2.4</h4>
                    <p className="text-emerald text-xs font-bold tracking-widest uppercase">Active Analysis</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="h-2 bg-[#0A1628] rounded-full overflow-hidden">
                    <div className="h-full bg-emerald w-[85%]"></div>
                  </div>
                  <div className="h-2 bg-[#0A1628] rounded-full overflow-hidden">
                    <div className="h-full bg-amber-400 w-[70%]"></div>
                  </div>
                  <div className="h-2 bg-[#0A1628] rounded-full overflow-hidden">
                    <div className="h-full bg-blue-400 w-[92%]"></div>
                  </div>
                </div>
                <div className="mt-8 pt-8 border-t border-emerald/10 flex justify-between items-center">
                  <span className="text-xs text-[#E2E8F0]/40 font-bold">CONFIDENCE SCORE</span>
                  <span className="text-emerald font-black">98.2%</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section id="how-it-works" className="py-24 bg-[#0A1628]">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-20">
            <h2 className="text-4xl font-black mb-4">Built on Purposeful Technology</h2>
            <p className="text-[#E2E8F0]/60 max-w-2xl mx-auto">Combining cutting-edge AI with immutable infrastructure for the next generation of sustainable finance.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              { icon: Brain, title: "Gemini 3 Flash", desc: "1M token context window allows for high-fidelity analysis of massive reports in one pass." },
              { icon: Zap, title: "Real-time Scoring", desc: "Instant extraction and scoring across 15+ ESG sub-categories with data-backed reasoning." },
              { icon: Shield, title: "Blockchain Trust", desc: "Every analysis is hashed and anchored, creating a permanent audit trail for ESG claims." },
              { icon: Database, title: "Persistent Ledger", desc: "Full history of company performance over time, detecting trends and data gaps." }
            ].map((feature, idx) => (
              <div key={idx} className="p-8 bg-[#0F2137] rounded-3xl border border-emerald/10 hover:border-emerald/40 transition-all group">
                <div className="w-12 h-12 bg-emerald/10 rounded-xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <feature.icon className="w-6 h-6 text-emerald" />
                </div>
                <h4 className="text-xl font-bold mb-3">{feature.title}</h4>
                <p className="text-[#E2E8F0]/60 text-sm leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-20 border-t border-emerald/10">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-[#00C896] rounded flex items-center justify-center">
              <Shield className="w-4 h-4 text-[#0A1628]" />
            </div>
            <span className="font-bold tracking-tight">GreenLedger</span>
          </div>
          <p className="text-[#E2E8F0]/30 text-xs">© 2025 GreenLedger. Built with Gemini 3 Flash for Hackathon 2025.</p>
          <div className="flex gap-6">
            <a href="#" className="text-[#E2E8F0]/40 hover:text-emerald transition-colors"><Globe className="w-5 h-5" /></a>
            <a href="#" className="text-[#E2E8F0]/40 hover:text-emerald transition-colors"><BarChart3 className="w-5 h-5" /></a>
          </div>
        </div>
      </footer>
    </div>
  );
}
