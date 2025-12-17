import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function ECGVisualizer(){
  const navigate = useNavigate()
  // Defaults and constants
  const DEFAULT_SAMPLE_RATE = 125
  const DEFAULT_PAPER_SPEED = 25 // mm/s
  const DEFAULT_MM_PER_MV = 10 // mm per mV
  const DEFAULT_PIXELS_PER_MM = 3
  const DEFAULT_SECONDS = 5
  const CAPTURE_SECONDS = 15 // automatic report duration (seconds)
  const WAIT_SECONDS = 10 // wait time after capture before report ready
  const ADC_MAX = 1023
  const VREF = 5.0

  const [connected, setConnected] = useState(false)
  const [gain, setGain] = useState(1.0)
  const [sampleRate, setSampleRate] = useState(DEFAULT_SAMPLE_RATE)
  const [isCalibrating, setIsCalibrating] = useState(false)
  const [pixelsPerMm, setPixelsPerMm] = useState(DEFAULT_PIXELS_PER_MM)
  const [secondsWindow, setSecondsWindow] = useState(DEFAULT_SECONDS)
  const [inputUnits, setInputUnits] = useState('mv') // 'mv' | 'adc'
  const [filterOn, setFilterOn] = useState(true) // DSP bandpass (0.5–40 Hz)
  const [advancedReport, setAdvancedReport] = useState(true)

  // Final Report Recording (15 seconds + 10s wait)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingProgress, setRecordingProgress] = useState(0)
  const [isWaiting, setIsWaiting] = useState(false)
  const [waitProgress, setWaitProgress] = useState(0)
  const [showReport, setShowReport] = useState(false)
  const [recordedData, setRecordedData] = useState(null)
  const [connectError, setConnectError] = useState(null)
  const reportCanvasRef = useRef(null)

  const leads = ['Lead I','Lead II','Lead III','aVR','aVL','aVF']
  // Paired layout: [Lead I, aVL], [Lead II, aVF], [Lead III, aVR]
  const leadPairs = [
    [0, 4], // Lead I (idx 0) + aVL (idx 4)
    [1, 5], // Lead II (idx 1) + aVF (idx 5)
    [2, 3]  // Lead III (idx 2) + aVR (idx 3)
  ]

  // Refs
  const portRef = useRef(null)
  const readerRef = useRef(null)
  const bufferRef = useRef([]) // Float32Array per lead
  const writeIndexRef = useRef(0)
  const runningRef = useRef(false)
  const pairCanvasRefs = useRef([]) // 3 canvases for 3 rows of paired leads
  // DSP filter state per lead (one-pole HP + one-pole LP)
  const hpStateRef = useRef(leads.map(()=>({x1:0,y1:0})))
  const lpStateRef = useRef(leads.map(()=>({y1:0})))
  const hpAlphaRef = useRef(0)
  const lpAlphaRef = useRef(0)
  // Recording via refs to avoid stale closures
  const recordRef = useRef({ active:false, data:null, count:0 })
  const autoStopTriggeredRef = useRef(false)
  const manualStopRef = useRef(false)
  const sampleRateRef = useRef(sampleRate)
  const freezeDisplayRef = useRef(false)
  const frozenBufferRef = useRef(null)

  // (re)initialize buffers when secondsWindow changes
  useEffect(()=>{
    const samples = Math.max(1, Math.floor(sampleRate * secondsWindow))
    bufferRef.current = leads.map(()=>new Float32Array(samples))
    writeIndexRef.current = 0
  },[secondsWindow, sampleRate])

  // Size helper to keep canvas attributes in sync with settings
  function sizeAllCanvases(){
    const samples = bufferRef.current[0]?.length || Math.max(1, Math.floor(sampleRate * secondsWindow))
    const mmPerSample = DEFAULT_PAPER_SPEED / sampleRate
    const width = Math.max(800, Math.floor(samples * pixelsPerMm * mmPerSample))
    for (let i=0; i<leadPairs.length; i++){
      const el = pairCanvasRefs.current[i]
      if(!el) continue
      el.width = width
      el.height = 100 // Height for one row with 2 leads side by side
    }
  }

  // Ensure canvas dimensions track settings
  useEffect(()=>{ sizeAllCanvases() },[pixelsPerMm, secondsWindow])

  // keep sampleRate in a ref for use inside serial loop
  useEffect(()=>{ sampleRateRef.current = sampleRate },[sampleRate])

  // Recompute filter coefficients when sampleRate changes
  useEffect(()=>{
    const dt = 1/Math.max(1, sampleRateRef.current)
    // High-pass ~0.5 Hz
    const hpFc = 0.5
    const hpRc = 1/(2*Math.PI*hpFc)
    hpAlphaRef.current = hpRc/(hpRc + dt)
    // Low-pass ~40 Hz
    const lpFc = 40
    const lpRc = 1/(2*Math.PI*lpFc)
    lpAlphaRef.current = dt/(lpRc + dt)
    // reset states when rate changes
    hpStateRef.current = leads.map(()=>({x1:0,y1:0}))
    lpStateRef.current = leads.map(()=>({y1:0}))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[sampleRate])

  // Convert incoming value to mV (heuristic)
  function valueToMv(v){
    if (typeof v !== 'number' || isNaN(v)) return 0
    if (inputUnits === 'adc'){
      // Treat v as raw ADC counts (0..1023) and convert to mV using VREF
      const volts = (v * VREF) / ADC_MAX
      return volts * 1000
    }
    // inputUnits === 'mv': already in millivolts
    return v
  }

  function drawGrid(ctx, width, height, pixelsPerMm){
    // Dark theme grid
    ctx.fillStyle = '#0b0f14'
    ctx.fillRect(0,0,width,height)
    const px = pixelsPerMm
    ctx.strokeStyle = 'rgba(148,163,184,0.12)'
    ctx.lineWidth = 0.6
    for(let x=0;x<=width;x+=px){ctx.beginPath();ctx.moveTo(x+0.5,0);ctx.lineTo(x+0.5,height);ctx.stroke()}
    for(let y=0;y<=height;y+=px){ctx.beginPath();ctx.moveTo(0,y+0.5);ctx.lineTo(width,y+0.5);ctx.stroke()}
    ctx.strokeStyle = 'rgba(148,163,184,0.22)'
    ctx.lineWidth = 1.0
    for(let x=0;x<=width;x+=px*5){ctx.beginPath();ctx.moveTo(x+0.5,0);ctx.lineTo(x+0.5,height);ctx.stroke()}
    for(let y=0;y<=height;y+=px*5){ctx.beginPath();ctx.moveTo(0,y+0.5);ctx.lineTo(width,y+0.5);ctx.stroke()}
  }

  function drawAll(){
    const samples = bufferRef.current[0]?.length || 1
    const mmPerSample = DEFAULT_PAPER_SPEED / sampleRate
    const xStep = pixelsPerMm * mmPerSample

    // Draw each row with paired leads side by side
    for(let rowIdx=0; rowIdx<leadPairs.length; rowIdx++){
      const canvas = pairCanvasRefs.current[rowIdx]
      if(!canvas) continue
      const ctx = canvas.getContext('2d')
      const w = canvas.width
      const h = canvas.height

      drawGrid(ctx,w,h,pixelsPerMm)

      const [leftLeadIdx, rightLeadIdx] = leadPairs[rowIdx]
      const halfW = w / 2
      
      // If display is frozen, draw from frozenBuffer snapshot; otherwise draw from live ring buffer
      if (freezeDisplayRef.current && frozenBufferRef.current) {
        const frozen = frozenBufferRef.current
        drawLeadTrace(ctx, leftLeadIdx, 0, halfW, h, samples, xStep, leads[leftLeadIdx], frozen[leftLeadIdx])
        drawLeadTrace(ctx, rightLeadIdx, halfW, halfW, h, samples, xStep, leads[rightLeadIdx], frozen[rightLeadIdx])
      } else {
        // Draw left lead (e.g., Lead I)
        drawLeadTrace(ctx, leftLeadIdx, 0, halfW, h, samples, xStep, leads[leftLeadIdx])
        
        // Draw right lead (e.g., aVL)
        drawLeadTrace(ctx, rightLeadIdx, halfW, halfW, h, samples, xStep, leads[rightLeadIdx])
      }
    }
  }

  // samplesArr is an optional plain array used when drawing a frozen snapshot.
  function drawLeadTrace(ctx, leadIdx, xOffset, width, height, samples, xStep, leadName, samplesArr){
    const baselineY = Math.floor(height/2)
    
    // midline
    ctx.strokeStyle='rgba(148,163,184,0.12)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    ctx.moveTo(xOffset, baselineY+0.5)
    ctx.lineTo(xOffset + width, baselineY+0.5)
    ctx.stroke()

    // calibration pulse (1 mV, 200 ms) at left
    const calHeightPx = 10 * pixelsPerMm // 10 mm = 1 mV
    const calWidthPx = 5 * pixelsPerMm   // 5 mm = 0.2 s at 25 mm/s
    const calX = xOffset + 8
    ctx.fillStyle = '#00d9ff'
    ctx.shadowColor = 'rgba(0,217,255,0.5)'
    ctx.shadowBlur = 8
    ctx.beginPath()
    ctx.moveTo(calX, baselineY)
    ctx.lineTo(calX, baselineY - calHeightPx)
    ctx.lineTo(calX + calWidthPx, baselineY - calHeightPx)
    ctx.lineTo(calX + calWidthPx, baselineY)
    ctx.closePath()
    ctx.fill()
    ctx.shadowBlur = 0

    // Lead label
    ctx.fillStyle = 'rgba(229,231,235,0.9)'
    ctx.font = '12px Inter, system-ui, Arial'
    ctx.fillText(leadName, calX + calWidthPx + 6, 14)

    // waveform
    ctx.lineWidth = 1.6
    ctx.strokeStyle = '#00d9ff'
    ctx.shadowColor = 'rgba(0,217,255,0.4)'
    ctx.shadowBlur = 6
    ctx.beginPath()
    let x = xOffset
    if (samplesArr && Array.isArray(samplesArr)){
      // draw from frozen array sequentially
      for (let s=0; s<samplesArr.length; s++){
        const mv = samplesArr[s] || 0
        const mm = mv * DEFAULT_MM_PER_MV * gain
        const y = baselineY - mm * pixelsPerMm
        if (s===0) ctx.moveTo(x,y)
        else ctx.lineTo(x,y)
        x += xStep
        if (x > xOffset + width + 2) break
      }
    } else {
      // live ring buffer draw
      for(let s=0;s<samples;s++){
        const idx = (writeIndexRef.current + s) % samples
        const mv = bufferRef.current[leadIdx][idx] || 0
        const mm = mv * DEFAULT_MM_PER_MV * gain
        const y = baselineY - mm * pixelsPerMm
        if(s===0) ctx.moveTo(x,y)
        else ctx.lineTo(x,y)
        x += xStep
        if (x > xOffset + width + 2) break
      }
    }
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'
  }

  // One-pole high-pass followed by one-pole low-pass per-lead
  function filterSample(leadIdx, x){
    // high-pass: y[n] = a*(y[n-1] + x[n] - x[n-1])
    const aHP = hpAlphaRef.current
    const stHP = hpStateRef.current[leadIdx]
    const yHP = aHP * (stHP.y1 + x - stHP.x1)
    stHP.x1 = x
    stHP.y1 = yHP
    // low-pass: y[n] = y[n-1] + a*(x - y[n-1]) with x=yHP
    const aLP = lpAlphaRef.current
    const stLP = lpStateRef.current[leadIdx]
    const y = stLP.y1 + aLP * (yHP - stLP.y1)
    stLP.y1 = y
    return y
  }

  // animation - always run so live ECG continues while report modal is open
  useEffect(()=>{
    let raf = null
    function tick(){ drawAll(); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return ()=>{ if(raf) cancelAnimationFrame(raf) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pixelsPerMm,secondsWindow,gain])

  // Draw report to a given canvas (shared by modal and export)
  function drawReportPage(canvas, data) {
    const ctx = canvas.getContext('2d')
    const ppm = 6 // pixels per mm - realistic ECG paper resolution
    const paperWidth = 280 // mm - standard ECG strip width
    const paperHeight = 200 // mm - realistic height for 6 leads
    canvas.width = paperWidth * ppm
    canvas.height = paperHeight * ppm

    // Background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Grid - standard ECG paper (1mm minor, 5mm major)
    // Minor 1mm grid
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)'
    ctx.lineWidth = 1
    for (let x = 0; x <= canvas.width; x += ppm) { 
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke() 
    }
    for (let y = 0; y <= canvas.height; y += ppm) { 
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke() 
    }
    // Major 5mm grid (0.5 second at 25mm/s, 0.5mV at 10mm/mV)
    ctx.strokeStyle = 'rgba(220,38,38,0.9)'
    ctx.lineWidth = 2
    for (let x = 0; x <= canvas.width; x += ppm*5) { 
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke() 
    }
    for (let y = 0; y <= canvas.height; y += ppm*5) { 
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke() 
    }

    const marginMm = 8
    const margin = marginMm * ppm
    const headerMm = 28
    const headerH = headerMm * ppm

    // Header with comprehensive info
    ctx.fillStyle = '#000'
    ctx.font = 'bold 18px Arial, Helvetica, sans-serif'
  const firstLead = data['Lead I'] || data['I'] || data['Lead II'] || data['II'] || data['Lead III'] || data['III']
  const recordedSeconds = firstLead ? (firstLead.length / sampleRate).toFixed(1) : '0.0'
  // If metadata exists, show that this is a 1s excerpt at the 15s mark (or other capture time)
  const meta = data && data.__meta ? data.__meta : null
  const headerTitle = meta && meta.excerptSeconds && meta.captureAt ? `NextECG — 6-Lead ECG Report (excerpt ${meta.excerptSeconds}s at ${meta.captureAt}s)` : `NextECG — 6-Lead ECG Report (${recordedSeconds}s)`
  ctx.fillText(headerTitle, margin, margin + 14)
    
    ctx.font = '12px Arial, Helvetica, sans-serif'
    const dateStr = new Date().toLocaleString()
    ctx.fillText(`Date: ${dateStr}`, margin, margin + 30)
    
  // Technical parameters
  ctx.fillText(`Time Domain: 25 mm/s  |  Amplitude: 10 mm/mV  |  Sample Rate: ${sampleRate} Hz`, margin, margin + 44)
  const recordingLabelSeconds = meta && meta.excerptSeconds ? `${meta.excerptSeconds}` : recordedSeconds
  ctx.fillText(`Frequency Domain: Filter 0.5–40 Hz (Bandpass)  |  Recording: ${recordingLabelSeconds} seconds`, margin, margin + 58)

    // Calibration pulse 1mV
    const calX = margin
    const calY = margin + headerH - (12*ppm)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(calX, calY)
    ctx.lineTo(calX, calY + 10*ppm)
    ctx.lineTo(calX + 5*ppm, calY + 10*ppm)
    ctx.lineTo(calX + 5*ppm, calY)
    ctx.stroke()
    ctx.fillText('1mV', calX + 6*ppm, calY + 6*ppm)

    // Seconds markers across header
    const sampleLead = data['I'] || data['II'] || data['III'] || data['aVR'] || data['aVL'] || data['aVF']
    const totalSeconds = sampleLead ? sampleLead.length / sampleRate : 10
    const secondsToShow = Math.ceil(totalSeconds)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 1.5
    ctx.font = '12px Arial, Helvetica, sans-serif'
    for (let s=0; s<=secondsToShow; s++){
      const x = margin + s * 25 * ppm
      ctx.beginPath(); ctx.moveTo(x, margin + headerH - 20); ctx.lineTo(x, margin + headerH - 10); ctx.stroke()
      ctx.fillText(`${s}s`, x + 3, margin + headerH - 14)
    }

    // Normalize/ensure leads: prefer 'Lead I' keys but accept multiple variants.
    const shortKeys = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF']
    const longLabels = ['Lead I','Lead II','Lead III','aVR','aVL','aVF']
    // Build normalized map
    const norm = {}
    function findSamples(variants){ for (const v of variants){ if (data && data[v]) return data[v] } return null }
    for (let i=0;i<shortKeys.length;i++){
      const short = shortKeys[i]
      const long = longLabels[i]
      norm[short] = findSamples([long, short, `Lead ${short}`])
    }
    // Derive missing leads if requested
    if (advancedReport) {
      if (!norm['III'] && norm['I'] && norm['II']){
        const a = norm['II'], b = norm['I']; const len = Math.min(a.length, b.length); const arr = new Array(len)
        for (let k=0;k<len;k++) arr[k] = a[k] - b[k]
        norm['III'] = arr
      }
      if ((!norm['aVR'] || !norm['aVL'] || !norm['aVF']) && norm['I'] && norm['II']){
        const I = norm['I'], II = norm['II']; const len = Math.min(I.length, II.length)
        const avr = new Array(len), avl = new Array(len), avf = new Array(len)
        for (let k=0;k<len;k++){ const la=I[k], ll=II[k], ra=0.0; avr[k]=ra-(la+ll)/2; avl[k]=la-(ra+ll)/2; avf[k]=ll-(ra+la)/2 }
        if (!norm['aVR']) norm['aVR']=avr
        if (!norm['aVL']) norm['aVL']=avl
        if (!norm['aVF']) norm['aVF']=avf
      }
    }
    const leadHeightMm = 26
    const leadHeight = leadHeightMm * ppm
    const startY = margin + headerH + 5
    const innerWidth = canvas.width - 2*margin

    // draw paired rows: [Lead I | aVL], [Lead II | aVF], [Lead III | aVR]
    const pairList = [[0,4],[1,5],[2,3]]
    const gapMm = 6
    const gapPx = gapMm * ppm
    const colWidth = Math.floor((innerWidth - gapPx) / 2)
    for (let row=0; row<pairList.length; row++){
      const [leftIdx, rightIdx] = pairList[row]
      const leftShort = shortKeys[leftIdx]
      const rightShort = shortKeys[rightIdx]
      const leftLabel = longLabels[leftIdx]
      const rightLabel = longLabels[rightIdx]
      const yBase = startY + row * leadHeight + (leadHeight/2)
      const leftX = margin
      const rightX = margin + colWidth + gapPx
      drawReportLeadStrip(ctx, norm[leftShort] || null, leftLabel, leftX, yBase, colWidth, ppm)
      drawReportLeadStrip(ctx, norm[rightShort] || null, rightLabel, rightX, yBase, colWidth, ppm)
    }
  }

  // When report is shown, render into the visible canvas
  useEffect(() => {
    if (!showReport || !recordedData || !reportCanvasRef.current) return
    drawReportPage(reportCanvasRef.current, recordedData)
  }, [showReport, recordedData, sampleRate, gain])

  function drawReportLeadStrip(ctx, samples, leadName, xStart, yBase, width, ppm) {
    if (!samples || samples.length === 0) return
    
    // Lead label - BOLD BLACK, proper names
    ctx.fillStyle = '#000000'
    ctx.font = 'bold 16px Arial, Helvetica, sans-serif'
    ctx.fillText(leadName, xStart + 2, yBase - 12)
    
    // Baseline reference
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'
    ctx.lineWidth = 0.8
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(xStart, yBase)
    ctx.lineTo(xStart + width, yBase)
    ctx.stroke()
    ctx.setLineDash([])

    // Per-lead second ticks at baseline (25mm intervals)
    const mmPerSec = 25
    const totalSeconds = samples.length / sampleRate
    const totalWidthMm = totalSeconds * mmPerSec
    const availWidthMm = (width / ppm) - 5
    const timeScale = Math.min(1.0, availWidthMm / totalWidthMm)
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth = 1
    for (let s = 0; s <= Math.ceil(totalSeconds); s++){
      const xMm = s * mmPerSec * timeScale
      const x = xStart + (xMm * ppm)
      ctx.beginPath(); ctx.moveTo(x, yBase - 6); ctx.lineTo(x, yBase + 6); ctx.stroke()
    }
    
    // ECG WAVEFORM - THICK BLACK with ANTI-ALIASING
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.shadowColor = 'rgba(0,0,0,0.2)'
    ctx.shadowBlur = 1
    
    ctx.beginPath()
    
  const mmPerSec2 = 25 // standard ECG paper speed
  const totalSeconds2 = samples.length / sampleRate
  const totalWidthMm2 = totalSeconds2 * mmPerSec2 // total width needed in mm
  const availWidthMm2 = (width / ppm) - 5 // available width minus padding
    
  // If recording is longer than available width, compress time scale proportionally
  const timeScale2 = Math.min(1.0, availWidthMm2 / totalWidthMm2)
    
    for (let i = 0; i < samples.length; i++) {
  const timeSec = i / sampleRate
  const xMm = timeSec * mmPerSec2 * timeScale2
      const xPos = xStart + (xMm * ppm)
      
      const mv = samples[i]
      const yMm = mv * DEFAULT_MM_PER_MV * gain // 10mm per mV standard
      const yPos = yBase - (yMm * ppm)
      
      if (i === 0) {
        ctx.moveTo(xPos, yPos)
      } else {
        ctx.lineTo(xPos, yPos)
      }
    }
    ctx.stroke()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
  }

  // connect via Web Serial
  async function connect(){
    setConnectError(null)
    if(!('serial' in navigator)) { setConnectError('Web Serial API not available in this browser. Use Chrome or Edge.'); alert('Use Chrome or Edge with Web Serial enabled'); return }
    try{
      // Helpful diagnostic: list already-authorized ports
      if (navigator.serial.getPorts) {
        try { const existing = await navigator.serial.getPorts(); console.debug('Previously authorized serial ports:', existing.length) } catch(e){ console.debug('getPorts failed', e) }
      }
      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: 115200 })
      portRef.current = port
      setConnected(true)
      const decoder = new TextDecoderStream()
      port.readable.pipeTo(decoder.writable)
      const reader = decoder.readable.getReader()
      readerRef.current = reader
  runningRef.current = true
  // enter calibration mode on connect; Arduino typically calibrates for ~5s
  setIsCalibrating(true)
  // fallback: turn off calibration after 5s unless device announces completion
  const calibTimeout = setTimeout(()=>{ setIsCalibrating(false) }, 5000)
      let textBuffer = ''

      while(runningRef.current){
        const { value, done } = await reader.read()
        if(done) break
        textBuffer += value
        const lines = textBuffer.split('\n')
        textBuffer = lines.pop() || ''
        for(let line of lines){
          line = line.trim(); if(!line) continue
          // Detect calibration logs from Arduino (case-insensitive)
          const lower = line.toLowerCase()
          if(lower.includes('calibration complete') || lower.includes('calibrated') || lower.includes('calibration done')){
            setIsCalibrating(false)
            clearTimeout(calibTimeout)
            continue
          }
          if(lower.includes('starting') && lower.includes('calibration')){
            setIsCalibrating(true)
            continue
          }
          // Robust parse: accept JSON, 6-value CSV, or 2-value CSV (Lead I, Lead II)
          let arr = null
          let parsedJson = null
          try{ parsedJson = JSON.parse(line) }catch(_e){ parsedJson = null }
          if(parsedJson && typeof parsedJson === 'object'){
            const keys = ['lead1','lead2','lead3','avr','avl','avf']
            if(keys.every(k=>k in parsedJson)){
              arr = keys.map(k=>parseFloat(parsedJson[k]))
            }
          }
          if(!arr){
            const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(v=>parseFloat(v))
            if(nums.length >= 6){
              arr = nums.slice(0,6)
            } else if(nums.length === 2){
              // Build derived leads from Lead I (LA-RA) and Lead II (LL-RA)
              const lead1 = nums[0]
              const lead2 = nums[1]
              const lead3 = lead2 - lead1
              const ra = 0.0, la = lead1, ll = lead2
              const avr = ra - (la + ll)/2
              const avl = la - (ra + ll)/2
              const avf = ll - (ra + la)/2
              arr = [lead1, lead2, lead3, avr, avl, avf]
            }
          }
          if(!arr) continue

          // If we are calibrating, don't write incoming signal samples to the visible buffer.
          // This prevents the frontend from showing unstable signals during the Arduino's auto-cal phase.
          if(isCalibrating){
            continue
          }

          // Convert and optionally filter
          const mvs = arr.map(v => valueToMv(v))
          for(let i=0;i<mvs.length;i++){
            if(filterOn) mvs[i] = filterSample(i, mvs[i])
          }

          // Recording for final report (continuous until user stops)
          if (recordRef.current.active && recordRef.current.data) {
            leads.forEach((ln, idx) => {
              recordRef.current.data[ln].push(mvs[idx])
            })
            recordRef.current.count += 1
            // Use timestamp-based duration for robustness
            const nowSec = Date.now()/1000
            const start = recordRef.current.startTime || nowSec
            const duration = nowSec - start
            setRecordingProgress(duration)
            // Auto-stop when we reach CAPTURE_SECONDS seconds (guard to call once)
            if (duration >= CAPTURE_SECONDS && !autoStopTriggeredRef.current) {
              autoStopTriggeredRef.current = true
              try { stopRecording({ auto: true, captureSecond: CAPTURE_SECONDS }) } catch(e){ console.warn('auto-stop failed', e) }
            }
          }

          const samples = bufferRef.current[0]?.length || Math.max(1,Math.floor(sampleRate*secondsWindow))
          for(let i=0;i<mvs.length;i++){
            const mv = mvs[i]
            if(!bufferRef.current[i]) bufferRef.current[i] = new Float32Array(samples)
            bufferRef.current[i][writeIndexRef.current] = mv
          }
          writeIndexRef.current = (writeIndexRef.current + 1) % samples
        }
      }
    }catch(err){
      console.error('Serial connect error', err)
      const msg = err && err.message ? err.message : String(err)
      setConnectError(msg)
      alert('Connection failed: '+msg)
      setConnected(false)
    }
  }

  async function disconnect(){
    runningRef.current = false
    setConnected(false)
    setIsRecording(false)
    try{
      if(readerRef.current){ await readerRef.current.cancel(); readerRef.current=null }
      if(portRef.current){ await portRef.current.close(); portRef.current=null }
    }catch(e){console.warn(e)}
  }

  function startRecording() {
    if (!portRef.current || !connected) {
      alert('Connect to device first!')
      return
    }
    // initialize ref buffers for each lead
    recordRef.current = { active:true, data:{}, count:0, startTime: Date.now()/1000 }
  autoStopTriggeredRef.current = false
  manualStopRef.current = false
    leads.forEach(ln => { recordRef.current.data[ln] = [] })
  // Clear any frozen display so live view resumes and allow incoming data
  frozenBufferRef.current = null
  freezeDisplayRef.current = false
    setRecordingProgress(0)
    setIsRecording(true)
    setShowReport(false)
  }

  function stopRecording(options = { auto: false, captureSecond: CAPTURE_SECONDS }) {
    const { auto, captureSecond } = options
    // If not recording and this isn't a forced auto-stop, ignore
    if (!isRecording && !auto && !recordRef.current.active) return

    // deactivate recording immediately
    recordRef.current.active = false
    setIsRecording(false)

    // Prepare snapshot object
    const snap = {}

    if (auto) {
      // For auto-stop we want the 1-second excerpt that ends at captureSecond (e.g., 14s..15s)
      const oneSecondSamples = Math.floor(1 * sampleRateRef.current)
      const sampleIndexEnd = Math.floor((captureSecond) * sampleRateRef.current)
      leads.forEach(ln => {
        const arr = recordRef.current.data[ln] || []
        // preferred: slice from (end - oneSecondSamples) .. end, but guard against short arrays
        let startIdx = sampleIndexEnd - oneSecondSamples
        if (startIdx < 0) startIdx = 0
        // If we don't yet have samples up to sampleIndexEnd (e.g., timing jitter), fall back to last oneSecondSamples
        if (arr.length >= sampleIndexEnd) {
          snap[ln] = arr.slice(Math.max(0, startIdx), Math.min(sampleIndexEnd, arr.length))
        } else {
          snap[ln] = arr.length > oneSecondSamples ? arr.slice(-oneSecondSamples) : arr.slice()
        }
      })
      // embed metadata so report can label the excerpt correctly
      snap.__meta = { excerptSeconds: 1, captureAt: captureSecond, sampleIndexEnd }
    } else {
      // user-initiated stop: keep entire captured buffer
      leads.forEach(ln => { snap[ln] = (recordRef.current.data[ln] || []).slice() })
      snap.__meta = { excerptSeconds: (snap[leads[0]]?.length || 0) / sampleRateRef.current, captureAt: null }
    }

    // Normalize snap into short keys and long keys and derive missing leads so report is consistent
    const normalized = {}
    // helper to set both short and long labels
    function setLead(short, long, arr){ if(!arr) arr = null; normalized[short] = arr; normalized[long] = arr }

    // populate from snap which uses long labels (e.g., 'Lead I')
    leads.forEach((longLabel, idx) => {
      const short = ['I','II','III','aVR','aVL','aVF'][idx]
      setLead(short, longLabel, snap[longLabel] || snap[short] || snap[`Lead ${short}`])
    })

    // If advancedReport, derive missing leads from I & II
    if (advancedReport) {
      const I = normalized['I']
      const II = normalized['II']
      if ((!normalized['III'] || !normalized['Lead III']) && I && II) {
        const len = Math.min(I.length, II.length)
        const arr = new Array(len)
        for (let k=0;k<len;k++) arr[k] = II[k] - I[k]
        setLead('III','Lead III', arr)
      }
      if ((!normalized['aVR'] || !normalized['aVL'] || !normalized['aVF']) && I && II) {
        const len = Math.min(I.length, II.length)
        const avr = new Array(len), avl = new Array(len), avf = new Array(len)
        for (let k=0;k<len;k++){
          const la = I[k]; const ll = II[k]; const ra = 0.0
          avr[k] = ra - (la + ll)/2
          avl[k] = la - (ra + ll)/2
          avf[k] = ll - (ra + la)/2
        }
        setLead('aVR','aVR', avr)
        setLead('aVL','aVL', avl)
        setLead('aVF','aVF', avf)
      }
    }

  setRecordedData(normalized)

    // If this was a manual stop (not auto), snapshot the current live ring buffer
    // and freeze the on-screen display so the user sees the exact frozen waveform.
    if (!auto) {
      try {
        const samples = bufferRef.current[0]?.length || 1
        const end = writeIndexRef.current
        const snapBuf = bufferRef.current.map(arr => {
          const out = new Array(samples)
          for (let s = 0; s < samples; s++) {
            const idx = (end + s) % samples
            out[s] = arr[idx]
          }
          return out
        })
        frozenBufferRef.current = snapBuf
        freezeDisplayRef.current = true
        console.debug('stopRecording: froze display snapshot (manual stop)', { samples, end })
      } catch (e) {
        console.warn('stopRecording: failed to create frozen snapshot', e)
        frozenBufferRef.current = null
        freezeDisplayRef.current = false
      }
      // mark manual stop so auto-start won't run
      manualStopRef.current = true
    } else {
      // For auto-stops we do not freeze the live display by default
      frozenBufferRef.current = null
      freezeDisplayRef.current = false
    }

    // Start wait period (processing)
    setIsWaiting(true)
    setWaitProgress(0)
  }

  // Countdown timer for 10-second wait after recording
  useEffect(() => {
    if (!isWaiting) return
    
    let elapsed = 0
    const interval = setInterval(() => {
      elapsed += 0.1
      setWaitProgress(elapsed)
      
      if (elapsed >= WAIT_SECONDS) {
        clearInterval(interval)
        setIsWaiting(false)
        setWaitProgress(0)
          // Report is now ready - user may open it via the 'View Report' button (no auto-popup)
      }
    }, 100)
    
    return () => clearInterval(interval)
  }, [isWaiting])

  // Auto-start capture after calibration completes
  useEffect(() => {
    if (connected && !isCalibrating && !isRecording && !showReport && !isWaiting && !manualStopRef.current) {
      const timer = setTimeout(() => {
        startRecording()
      }, 500) // Small delay to ensure calibration state is stable
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isCalibrating, isRecording, showReport, isWaiting])

  function downloadReport() {
    if (reportCanvasRef.current) {
      const link = document.createElement('a')
      link.download = 'ecg-report-15sec.png'
      link.href = reportCanvasRef.current.toDataURL()
      link.click()
    }
  }

  // export PNG - paired leads layout
  function exportPNG(){
    const cvsList = pairCanvasRefs.current.filter(Boolean)
    if(!cvsList.length) return
    const totalW = cvsList[0].width
    const totalH = cvsList.reduce((s,c)=>s+c.height,0)
    const out = document.createElement('canvas')
    out.width = totalW; out.height = totalH
    const ctx = out.getContext('2d')
    let y = 0
    for(let c of cvsList){ ctx.drawImage(c,0,y); y += c.height }
    const url = out.toDataURL('image/png')
    const a = document.createElement('a'); a.href = url; a.download = 'ecg_export.png'; a.click()
  }

  return (
    <div style={{background:'#0a0e12', minHeight:'100vh', padding:'20px'}}>
      {/* Back Button */}
      <button 
        onClick={() => navigate('/')} 
        style={{
          position: 'fixed',
          top: '20px',
          left: '20px',
          zIndex: 10000,
          background: '#1a2028',
          color: '#fff',
          border: '1px solid #2d3748',
          padding: '10px 20px',
          borderRadius: '8px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '14px',
          fontWeight: '600'
        }}
      >
        ← Back to Home
      </button>

      {/* Header */}
      <header style={{
        background: 'linear-gradient(135deg, #0f1620 0%, #1a2332 100%)',
        border: '1px solid #1b2330',
        borderRadius: '16px',
        padding: '24px 28px',
        marginBottom: '24px',
        marginTop: '50px'
      }}>
        <div style={{display:'flex',alignItems:'center',gap:'16px'}}>
          <div style={{
            width: '44px',
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 217, 255, 0.1)',
            borderRadius: '12px',
            border: '2px solid rgba(0, 217, 255, 0.3)'
          }}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <path d="M2 20 L10 20 L13 8 L17 32 L21 12 L25 28 L29 20 L38 20" 
                stroke="#00d9ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </div>
          <div>
            <h1 style={{margin:0,fontSize:'32px',fontWeight:900,color:'#fff'}}>
              <span style={{background:'linear-gradient(135deg, #00d9ff 0%, #7c3aed 50%, #ff2e97 100%)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>NEXT</span>
              <span style={{color:'#fff'}}>ECG</span>
            </h1>
            <p style={{margin:0,fontSize:'14px',color:'#9aa4b2'}}>Professional 6-Lead Cardiac Monitor</p>
          </div>
        </div>
      </header>

      {/* Final Report Modal */}
      {showReport && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.95)', zIndex: 9999,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', padding: '20px', overflowY: 'auto'
        }}>
          <div style={{ maxWidth: '100%', textAlign: 'center' }}>
            <h2 style={{ color: '#dc2626', marginBottom: '20px', fontSize: '24px', fontWeight: 'bold' }}>
              📄 ECG Report — 6-Lead Analysis
            </h2>
            <canvas ref={reportCanvasRef} style={{
              maxWidth: '100%', height: 'auto',
              border: '2px solid #dc2626', borderRadius: '4px',
              boxShadow: '0 0 20px rgba(220,38,38,0.3)'
            }} />
            <div style={{ marginTop: '20px', display: 'flex', gap: '15px', justifyContent: 'center' }}>
              <button onClick={downloadReport} className="btn" style={{
                background: '#dc2626', color: '#ffffff', fontWeight: 'bold', padding: '12px 24px'
              }}>
                💾 Download Report
              </button>
              <button onClick={()=>{ setShowReport(false); if(connected && !isCalibrating) { setRecordedData(null); startRecording() } }} className="btn" style={{ 
                background: '#41ff8b', color: '#0b0f14', fontWeight: 'bold', padding: '12px 24px'
              }}>
                🔁 Restart 15s Capture
              </button>
              <button onClick={()=>setShowReport(false)} className="btn" style={{ padding: '12px 24px' }}>
                ✕ Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="controls grid-card">
        <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
          {!connected ? (
            <button className="btn" onClick={connect}>🔌 Connect Device</button>
          ) : (
            <>
              <button className="btn" onClick={disconnect}>⛔ Disconnect</button>
              {!isRecording && !isCalibrating && (
                <button className="btn" onClick={startRecording} style={{background:'#00d9ff',color:'#071422',fontWeight:'700',marginLeft:8}}>▶ Start Recording</button>
              )}
            </>
          )}
          {connectError && (
            <div style={{color:'#ffb4b4',background:'#3b1212',padding:'8px 12px',borderRadius:6,marginLeft:8}}>
              <div style={{fontWeight:700}}>Serial error</div>
              <div style={{fontSize:12,opacity:0.9,whiteSpace:'pre-wrap'}}>{connectError}</div>
              <div style={{marginTop:8}}>
                <button className="btn" onClick={connect} style={{marginRight:8}}>Retry</button>
                <button className="btn" onClick={async ()=>{
                  try{ const ports = await navigator.serial.getPorts(); alert('Known ports: '+ports.length) }catch(e){ alert('getPorts failed: '+e) }
                }}>List Ports</button>
              </div>
            </div>
          )}
          
          {isRecording && (
            <button className="btn" onClick={()=>stopRecording()} style={{background:'#ef4444',color:'#fff',fontWeight:'bold'}}>
              ⏹ Stop Recording
            </button>
          )}
          
          <label>Gain: <input type="range" min="0.2" max="6" step="0.1" value={gain} onChange={e=>setGain(parseFloat(e.target.value))} /></label>
          <label>Pixels/mm: <input type="range" min="1" max="6" step="0.5" value={pixelsPerMm} onChange={e=>setPixelsPerMm(parseFloat(e.target.value))} /></label>
          <label>Window (s): <input type="number" min="1" max="10" value={secondsWindow} onChange={e=>setSecondsWindow(parseInt(e.target.value)||1)} /></label>
          <label>Sample rate (Hz): <input type="number" min="20" max="1000" step="1" value={sampleRate} onChange={e=>setSampleRate(Math.max(1, parseInt(e.target.value)||DEFAULT_SAMPLE_RATE))} /></label>
          <label>Input Units: 
            <select value={inputUnits} onChange={e=>setInputUnits(e.target.value)}>
              <option value="mv">mV</option>
              <option value="adc">ADC (0-1023)</option>
            </select>
          </label>
          <label style={{display:'flex',alignItems:'center',gap:6}}>
            <input type="checkbox" checked={filterOn} onChange={e=>setFilterOn(e.target.checked)} />
            <span>Filter 0.5–40 Hz</span>
          </label>
          <label style={{display:'flex',alignItems:'center',gap:6}} title="Try to ensure all 6 leads appear on the printed report (derive missing leads from I & II)">
            <input type="checkbox" checked={advancedReport} onChange={e=>setAdvancedReport(e.target.checked)} />
            <span>Advanced Report (force 6 leads)</span>
          </label>
          <button className="btn" onClick={exportPNG}>📷 Export Live PNG</button>
          {recordedData && (
            <button className="btn" onClick={() => {
              // Export report offscreen without opening modal
              const off = document.createElement('canvas')
              drawReportPage(off, recordedData)
              const a = document.createElement('a')
              a.href = off.toDataURL('image/png')
              a.download = 'ecg-report-15sec.png'
              a.click()
            }}>⬇ Export Report PNG</button>
          )}
          {recordedData && !isWaiting && (
            <button className="btn" onClick={() => setShowReport(true)} title="View the red-grid report" style={{background:'#dc2626',color:'#fff'}}>
              🩺 View Report
            </button>
          )}
          <div style={{marginLeft:'auto',fontSize:14,fontWeight:600}}>
            Status: <strong className={isRecording || isWaiting ? 'recording-indicator' : ''} style={{color: isCalibrating ? '#f59e0b' : isRecording ? '#ff2e97' : isWaiting ? '#7c3aed' : (connected ? '#00d9ff' : '#6b7280')}}>
              {isCalibrating ? '🔄 Calibrating...' : 
               isRecording ? `⏺ Recording ${recordingProgress.toFixed(1)}s` : 
               isWaiting ? `⏳ Processing... ${(WAIT_SECONDS - waitProgress).toFixed(1)}s` :
               (connected ? '✓ Ready' : '⚠ Disconnected')}
            </strong>
          </div>
        </div>
      </div>

      {/* Paired Leads Display */}
      <div>
        {leadPairs.map((pair, rowIdx)=> {
          const [leftIdx, rightIdx] = pair
          return (
            <div key={rowIdx} className="grid-card" style={{marginBottom:8}}>
              <div className="lead-row">
                <div className="lead-title">{leads[leftIdx]} • {leads[rightIdx]}</div>
                <div style={{fontSize:12,color:'#6b7280'}}>10 mm/mV • 25 mm/s</div>
              </div>
              <canvas
                ref={el=>{ pairCanvasRefs.current[rowIdx]=el; if(el) sizeAllCanvases() }}
                style={{width:'100%',height:100,marginTop:8}}
              />
            </div>
          )
        })}
      </div>

      <div className="footer-note">
        Tip: After calibration, recording starts automatically. Click "⏹ Stop Recording" when you have 10-15 seconds of clean data. Wait 10s for processing, then view the steady ECG report with all 6 leads.
      </div>
    </div>
  )
}
