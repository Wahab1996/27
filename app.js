/* مصروفي AI — browser app. User API key exists in memory only during one analysis and is never persisted. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const palette = ["#6C63FF","#00A896","#FFB703","#E76F51","#219EBC","#8338EC","#06D6A0","#FB8500","#EF476F","#118AB2","#8AC926","#FF595E","#577590","#9B5DE5","#43AA8B","#F94144","#90BE6D","#F9844A"];
const categories = ["ثابت","تحويلات شخصية","السكن","السيارة","مطاعم وأكل","قهوة ومقاهي","بقالة ومقاضي","الصحة والصيدليات","الاتصالات","تسوق وعناية","تسوق متخصص","عناية شخصية","خدمات منزلية","مخالفات ورسوم","اشتراكات","سفر","تعليم","ترفيه","نقد / ATM","رسوم بنكية","أخرى","غير مصنف"];
const state = { file:null, statement:null, transactions:[], calculations:null, insights:null, memory:loadMemory(), apiKey:"" };

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL_NAME = "gpt-5.6-luna";

const extractionSchema = {
  type: "object", additionalProperties: false,
  required: ["bank_name","currency","statement_start","statement_end","opening_balance","closing_balance","bank_total_deposits","bank_total_withdrawals","bank_deposit_count","bank_withdrawal_count","transactions","warnings"],
  properties: {
    bank_name:{type:["string","null"]}, currency:{type:"string"}, statement_start:{type:["string","null"]}, statement_end:{type:["string","null"]},
    opening_balance:{type:["number","null"]}, closing_balance:{type:["number","null"]}, bank_total_deposits:{type:["number","null"]}, bank_total_withdrawals:{type:["number","null"]},
    bank_deposit_count:{type:["integer","null"]}, bank_withdrawal_count:{type:["integer","null"]}, warnings:{type:"array",items:{type:"string"}},
    transactions:{type:"array",items:{type:"object",additionalProperties:false,required:["date","time","original_description","merchant_raw","debit","credit","balance","transaction_kind"],properties:{
      date:{type:["string","null"]},time:{type:["string","null"]},original_description:{type:"string"},merchant_raw:{type:"string"},debit:{type:"number"},credit:{type:"number"},balance:{type:["number","null"]},transaction_kind:{type:"string"}
    }}}
  }
};

const classificationSchema = {
  type:"object",additionalProperties:false,required:["classifications"],properties:{
    classifications:{type:"array",items:{type:"object",additionalProperties:false,required:["index","merchant_normalized","category","subcategory","confidence","reason"],properties:{
      index:{type:"integer"},merchant_normalized:{type:"string"},category:{type:"string"},subcategory:{type:"string"},confidence:{type:"string",enum:["CONFIRMED","HIGH","MEDIUM","LOW","UNRESOLVED"]},reason:{type:"string"}
    }}}
  }
};

const insightsSchema = {
  type:"object",additionalProperties:false,required:["headline","insights"],properties:{
    headline:{type:"string"},insights:{type:"array",minItems:3,maxItems:8,items:{type:"object",additionalProperties:false,required:["title","text"],properties:{title:{type:"string"},text:{type:"string"}}}}
  }
};

function responseText(payload){
  if(typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const parts=[];
  for(const item of payload?.output||[]){
    if(item?.type!=="message") continue;
    for(const content of item?.content||[]) if(content?.type==="output_text" && typeof content.text==="string") parts.push(content.text);
  }
  return parts.join("\n").trim();
}
function safeJson(text){
  if(!text) throw new Error("استجابة الذكاء الاصطناعي فارغة.");
  try{return JSON.parse(text)}catch{}
  const a=text.indexOf("{"),b=text.lastIndexOf("}");
  if(a>=0&&b>a)return JSON.parse(text.slice(a,b+1));
  throw new Error("تعذر قراءة استجابة الذكاء الاصطناعي بصيغة JSON.");
}
async function callOpenAI(body){
  if(!state.apiKey) throw new Error("مفتاح OpenAI API غير موجود لهذه الجلسة.");
  const r=await fetch(OPENAI_URL,{method:"POST",headers:{"Authorization":`Bearer ${state.apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({...body,store:false})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){
    const msg=j?.error?.message || `OpenAI request failed (${r.status})`;
    if(r.status===401) throw new Error("مفتاح OpenAI API غير صحيح أو غير مخول.");
    if(r.status===429) throw new Error("تم بلوغ حد الاستخدام أو الرصيد في OpenAI API. تحقق من Billing/limits.");
    throw new Error(msg);
  }
  return j;
}

async function extractStatement(payload){
  const instructions=`You extract bank statements into structured data. Accuracy is more important than guessing.
Rules:
- Never invent a transaction, amount, date, balance, merchant, or statement total.
- Preserve the bank's original transaction description in original_description.
- debit and credit must always be non-negative numbers. Use 0 when the opposite side does not apply.
- Parse all visible transactions, including transfers, financing, fees, POS, Apple Pay, internet purchases, ATM, deposits, reversals and reservations when they are booked as transactions.
- Use ISO date YYYY-MM-DD where reliably known. If not reliable, return null.
- statement_start/end are the bank statement period, not the generation date.
- merchant_raw should be the shortest useful merchant/beneficiary label that can be supported by the statement.
- Do not classify spending categories here.
- If a field cannot be supported, return null and add a concise warning.
- If the statement contains bank-reported opening/closing/deposit/withdrawal totals, copy them exactly.
Return only data matching the schema.`;
  let content;
  if(payload.mode==="image"&&payload.fileData){
    content=[{type:"input_text",text:instructions},{type:"input_image",image_url:payload.fileData,detail:"high"}];
  }else if(payload.mode==="file"&&payload.fileData){
    const base64=String(payload.fileData).includes(",")?String(payload.fileData).split(",").pop():String(payload.fileData);
    content=[{type:"input_text",text:instructions},{type:"input_file",file_data:base64,filename:payload.filename||"statement.pdf"}];
  }else if(payload.text&&String(payload.text).trim()){
    content=[{type:"input_text",text:`${instructions}\n\nSTATEMENT CONTENT:\n${String(payload.text).slice(0,900000)}`}];
  }else throw new Error("لا توجد بيانات قابلة للتحليل في الملف.");
  const out=await callOpenAI({model:MODEL_NAME,input:[{role:"user",content}],text:{format:{type:"json_schema",name:"bank_statement_extraction",strict:true,schema:extractionSchema}}});
  return safeJson(responseText(out));
}

async function classifyTransactions(transactions, merchantMemory, webLookup=true){
  const compact=transactions.map((t,index)=>({index,date:t.date,amount:Number(t.debit||0),merchant_raw:t.merchant_raw||"",description:t.original_description||"",transaction_kind:t.transaction_kind||""})).filter(x=>x.amount>0);
  const instructions=`Classify personal bank-statement debit transactions. Be conservative and audit-friendly.
Allowed primary categories ONLY: ${categories.join(" | ")}.
Rules:
- Do not invent the exact purchased item from the merchant category alone.
- Example: SASCO for SAR 4.50 may be "السيارة / شراء داخل محطة وقود", not necessarily fuel.
- For clear recurring obligations use category "ثابت" with explicit subcategory such as "قسط التمويل", "الإيجار", or "تمارا / شراء مؤجل".
- Personal transfers go to "تحويلات شخصية" and should preserve recipient in subcategory where possible.
- Merchant identity confidence and exact-item confidence are different; reflect uncertainty in confidence/reason.
- Use "غير مصنف" + "غير معروف" + UNRESOLVED if the evidence is not sufficient.
- Do not force a category merely to improve coverage.
- Use merchantMemory when it clearly matches after normalizing punctuation/case/reference noise.
- Return one classification for every supplied debit index, no duplicates and no missing debit indexes.
Merchant memory: ${JSON.stringify(merchantMemory).slice(0,120000)}
Transactions: ${JSON.stringify(compact).slice(0,650000)}`;
  const body={model:MODEL_NAME,input:instructions,text:{format:{type:"json_schema",name:"transaction_classification",strict:true,schema:classificationSchema}}};
  if(webLookup) body.tools=[{type:"web_search"}];
  const out=await callOpenAI(body);
  return safeJson(responseText(out));
}

async function generateInsights(summary){
  const instructions=`Write concise Arabic financial insights from the supplied CALCULATED JSON only.
Do not recalculate or invent values. Do not shame the user. Do not give investment advice.
Focus on: biggest spending drivers, fixed-expense burden, transfers, discretionary spending, food/coffee/car, unusual high-spend days, merchant concentration, and classification coverage.
Use exact numbers already supplied. The UI is a dashboard, so keep each insight short and quantitative.
Calculated data:\n${JSON.stringify(summary).slice(0,300000)}`;
  const out=await callOpenAI({model:MODEL_NAME,input:instructions,text:{format:{type:"json_schema",name:"financial_insights",strict:true,schema:insightsSchema}}});
  return safeJson(responseText(out));
}

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

function loadMemory(){ try{return JSON.parse(localStorage.getItem("merchantMemory")||"{}")}catch{return {}} }
function saveMemory(){ localStorage.setItem("merchantMemory", JSON.stringify(state.memory||{})); }
function money(v){ return new Intl.NumberFormat("ar-SA",{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(v||0))+" ر.س"; }
function num(v){ const n=Number(v); return Number.isFinite(n)?n:0; }
function esc(s){ return String(s??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
function round2(v){ return Math.round((Number(v)+Number.EPSILON)*100)/100; }
function showError(msg){ const e=$("#errorBox"); e.textContent=msg; e.style.display="block"; }
function clearError(){ $("#errorBox").style.display="none"; }
function setStep(name,status="active",message=""){ $$(".step").forEach(x=>x.classList.remove("active")); const el=document.querySelector(`[data-step="${name}"]`); if(el){el.classList.add(status); if(status==="done")el.classList.add("done");} if(message)$("#statusline").textContent=message; }
function doneStep(name){ const el=document.querySelector(`[data-step="${name}"]`); if(el){el.classList.remove("active");el.classList.add("done");} }

$("#themeBtn").onclick=()=>{const r=document.documentElement,d=r.getAttribute("data-theme")==="dark";r.setAttribute("data-theme",d?"light":"dark");localStorage.setItem("theme",d?"light":"dark"); if(state.calculations)drawDaily();};
if(localStorage.getItem("theme"))document.documentElement.setAttribute("data-theme",localStorage.getItem("theme"));
$("#keyToggle").onclick=()=>{const input=$("#apiKeyInput"),show=input.type==="password";input.type=show?"text":"password";$("#keyToggle").textContent=show?"إخفاء":"إظهار";};
$("#chooseBtn").onclick=()=>$("#fileInput").click();
$("#demoBtn").onclick=()=>loadDemo();
$("#fileInput").onchange=e=>selectFile(e.target.files?.[0]);
const dz=$("#dropzone");
["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag")}));
["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag")}));
dz.addEventListener("drop",e=>selectFile(e.dataTransfer.files?.[0]));
$("#deleteBtn").onclick=()=>{ state.file=null;state.statement=null;state.transactions=[];state.calculations=null;state.insights=null;state.apiKey="";$("#apiKeyInput").value="";$("#apiKeyInput").type="password";$("#keyToggle").textContent="إظهار"; sessionStorage.clear(); $("#dashboard").style.display="none";$("#uploadView").style.display="grid";$("#fileChip").style.display="none";$("#progressWrap").style.display="none"; clearError(); };
$("#printBtn").onclick=()=>window.print();
$("#csvBtn").onclick=exportCSV; $("#jsonBtn").onclick=exportJSON;
["#searchTx","#filterCat","#filterType","#filterConfidence"].forEach(s=>$(s).addEventListener("input",renderAllTransactions));

async function selectFile(file){
  if(!file)return; clearError();
  const key=$("#apiKeyInput").value.trim();
  if(!key){ showError("أدخل مفتاح OpenAI API أولًا، ثم اختر كشف الحساب."); $("#apiKeyInput").focus(); $("#fileInput").value=""; return; }
  if(key.length<20){ showError("مفتاح OpenAI API يبدو غير مكتمل."); $("#apiKeyInput").focus(); $("#fileInput").value=""; return; }
  state.apiKey=key; state.file=file;
  $("#fileChip").style.display="block"; $("#fileChip").innerHTML=`<b>${esc(file.name)}</b><br><span class="kfoot">${(file.size/1024/1024).toFixed(2)} MB · ${esc(file.type||"ملف")}</span>`;
  $("#progressWrap").style.display="block";
  try{ await analyzeFile(file); }
  catch(e){ showError(e.message||"تعذر تحليل الملف"); $("#statusline").textContent="توقف التحليل"; }
  finally{ state.apiKey=""; $("#apiKeyInput").value=""; $("#apiKeyInput").type="password"; $("#keyToggle").textContent="إظهار"; }
}

async function analyzeFile(file){
  setStep("read","active","قراءة الملف محليًا...");
  const payload=await prepareInput(file); doneStep("read");
  setStep("extract","active","استخراج كل العمليات والبيانات البنكية...");
  const statement=await extractStatement(payload); state.statement=statement; doneStep("extract");
  state.transactions=(statement.transactions||[]).map((t,i)=>normalizeTx(t,i));
  if(!state.transactions.length)throw new Error("لم أجد عمليات قابلة للاستخراج من الكشف.");
  setStep("validate","active","مطابقة العمليات مع إجماليات البنك...");
  state.calculations=calculate(statement,state.transactions); doneStep("validate");
  setStep("classify","active","تصنيف التجار والمصروفات...");
  const debits=state.transactions.filter(t=>t.debit>0);
  const cls=await classifyTransactions(debits,state.memory,$("#webLookup").checked);
  mergeClassifications(debits,cls.classifications||[]); doneStep("classify");
  applyMerchantMemory(); state.calculations=calculate(statement,state.transactions);
  setStep("review","active","تحديد العمليات التي تحتاج مراجعة...");
  buildReview(); doneStep("review");
  setStep("build","active","بناء الداشبورد والتحليل...");
  renderDashboard();
  try{ state.insights=await generateInsights(summaryForAI()); renderInsights(); }catch{ renderFallbackInsights(); }
  doneStep("build"); $("#statusline").textContent="اكتمل التحليل";
  $("#uploadView").style.display="none";$("#dashboard").style.display="block";
  ["#printBtn","#csvBtn","#jsonBtn"].forEach(s=>$(s).classList.remove("hidden"));
  window.scrollTo({top:0,behavior:"smooth"});
}

async function prepareInput(file){
  const ext=file.name.split(".").pop().toLowerCase();
  if(ext==="pdf"){
    let text="";
    try{text=await extractPdfText(file);}catch{}
    if(text.replace(/\s/g,"").length>500) return {mode:"text",text,filename:file.name,mimeType:file.type};
    if(file.size>3.5*1024*1024) throw new Error("هذا PDF يبدو ممسوحًا ضوئيًا وحجمه كبير للإرسال المباشر. صدّره كصور أو استخدم PDF نصيًا في هذه النسخة.");
    return {mode:"file",fileData:await asDataURL(file),filename:file.name,mimeType:file.type};
  }
  if(["jpg","jpeg","png","webp"].includes(ext)) return {mode:"image",fileData:await asDataURL(file),filename:file.name,mimeType:file.type};
  if(ext==="csv") return {mode:"text",text:await file.text(),filename:file.name,mimeType:file.type};
  if(["xlsx","xls"].includes(ext)){
    const buf=await file.arrayBuffer(); const wb=XLSX.read(buf,{type:"array"}); let out="";
    wb.SheetNames.forEach(n=>{out+=`\n--- SHEET: ${n} ---\n`+XLSX.utils.sheet_to_csv(wb.Sheets[n]);});
    return {mode:"text",text:out,filename:file.name,mimeType:file.type};
  }
  throw new Error("نوع الملف غير مدعوم.");
}

async function extractPdfText(file){
  if(!window.pdfjsLib)throw new Error("PDF parser unavailable");
  const arr=await file.arrayBuffer(), pdf=await pdfjsLib.getDocument({data:arr}).promise; let out="";
  for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i), content=await page.getTextContent(); out+=`\n--- PAGE ${i} ---\n`+content.items.map(x=>x.str).join(" ");}
  return out;
}
function asDataURL(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)});}

function normalizeTx(t,i){return {id:`tx_${i+1}`,date:t.date||"",time:t.time||"",original_description:t.original_description||"",merchant_raw:t.merchant_raw||"غير معروف",merchant_normalized:t.merchant_raw||"غير معروف",debit:round2(Math.max(0,num(t.debit))),credit:round2(Math.max(0,num(t.credit))),balance:t.balance==null?null:round2(num(t.balance)),transaction_kind:t.transaction_kind||"",category:t.credit>0?"دخل":"غير مصنف",subcategory:t.credit>0?"إيداع":"غير معروف",confidence:t.credit>0?"CONFIRMED":"UNRESOLVED",classification_reason:t.credit>0?"إيداع":"لم يصنف بعد"};}

function mergeClassifications(debits,items){
  const byIndex=new Map(items.map(x=>[x.index,x]));
  debits.forEach((t,i)=>{const c=byIndex.get(i);if(!c)return;t.merchant_normalized=c.merchant_normalized||t.merchant_raw;t.category=categories.includes(c.category)?c.category:"غير مصنف";t.subcategory=c.subcategory||"غير معروف";t.confidence=c.confidence||"UNRESOLVED";t.classification_reason=c.reason||"";});
}
function merchantKey(s){return String(s||"").toUpperCase().replace(/\([^)]*\)/g," ").replace(/\d{6,}/g," ").replace(/[^A-Z0-9\u0600-\u06FF]+/g," ").trim().replace(/\s+/g," ");}
function applyMerchantMemory(){state.transactions.forEach(t=>{if(t.debit<=0)return;const k=merchantKey(t.merchant_raw),m=state.memory[k];if(!m)return;t.merchant_normalized=m.merchant_normalized||t.merchant_normalized;t.category=m.category||t.category;t.subcategory=m.subcategory||t.subcategory;t.confidence="CONFIRMED";t.classification_reason="تصنيف محفوظ من مراجعتك السابقة";});}

function calculate(statement,tx){
  const debits=tx.filter(t=>t.debit>0), credits=tx.filter(t=>t.credit>0);
  const totalDebit=round2(debits.reduce((s,t)=>s+t.debit,0)), totalCredit=round2(credits.reduce((s,t)=>s+t.credit,0));
  const opening=statement.opening_balance==null?0:round2(statement.opening_balance), closing=statement.closing_balance==null?null:round2(statement.closing_balance);
  const expected=closing==null?null:round2(opening+totalCredit-totalDebit), balanceDiff=closing==null?null:round2(expected-closing);
  const bankDebit=statement.bank_total_withdrawals==null?null:round2(statement.bank_total_withdrawals), bankCredit=statement.bank_total_deposits==null?null:round2(statement.bank_total_deposits);
  const cat={},sub={},merchant={},daily={};
  debits.forEach(t=>{cat[t.category]??={amount:0,count:0};cat[t.category].amount+=t.debit;cat[t.category].count++;const sk=t.category+"|||"+t.subcategory;sub[sk]??={category:t.category,subcategory:t.subcategory,amount:0,count:0};sub[sk].amount+=t.debit;sub[sk].count++;const mk=t.merchant_normalized||t.merchant_raw;merchant[mk]??={amount:0,count:0};merchant[mk].amount+=t.debit;merchant[mk].count++;daily[t.date||"غير محدد"]=(daily[t.date||"غير محدد"]||0)+t.debit;});
  Object.values(cat).forEach(x=>x.amount=round2(x.amount));Object.values(sub).forEach(x=>x.amount=round2(x.amount));Object.values(merchant).forEach(x=>x.amount=round2(x.amount));Object.keys(daily).forEach(k=>daily[k]=round2(daily[k]));
  const unknown=round2(cat["غير مصنف"]?.amount||0), classified=round2(totalDebit-unknown), coverage=totalDebit?round2(classified/totalDebit*100):100;
  const checks={balance:closing==null?null:Math.abs(balanceDiff)<=0.02,bankDebit:bankDebit==null?null:Math.abs(bankDebit-totalDebit)<=0.02,bankCredit:bankCredit==null?null:Math.abs(bankCredit-totalCredit)<=0.02};
  return {debits,credits,totalDebit,totalCredit,opening,closing,expected,balanceDiff,bankDebit,bankCredit,cat,sub,merchant,daily,unknown,classified,coverage,checks};
}

function buildReview(){
  const uncertain=state.transactions.filter(t=>t.debit>0 && ["LOW","UNRESOLVED"].includes(t.confidence));
  const box=$("#reviewBanner");
  if(!uncertain.length){box.classList.remove("show");return;}
  box.classList.add("show");box.innerHTML=`<div class="sectionTitle">مراجعة اختيارية · ${uncertain.length} عملية غير مؤكدة</div><div class="kfoot">يمكنك تعديل التصنيف، وسيتم تحديث كل الجداول والرسوم فورًا وحفظ اختيارك لهذا التاجر في جهازك.</div><div class="tableWrap" style="margin-top:12px"><table><thead><tr><th>التاريخ</th><th>الجهة</th><th>المبلغ</th><th>التصنيف الحالي</th><th>تعديل</th></tr></thead><tbody>${uncertain.map(t=>`<tr class="reviewRow"><td>${esc(t.date)}</td><td>${esc(t.merchant_raw)}</td><td class="money">${money(t.debit)}</td><td>${esc(t.category)} / ${esc(t.subcategory)}</td><td><div class="inlineEdit"><select data-review="${t.id}">${categories.map(c=>`<option ${c===t.category?'selected':''}>${c}</option>`).join('')}</select><button class="btn" data-save="${t.id}">حفظ</button></div></td></tr>`).join('')}</tbody></table></div>`;
  box.querySelectorAll("[data-save]").forEach(b=>b.onclick=()=>{const t=state.transactions.find(x=>x.id===b.dataset.save),sel=box.querySelector(`[data-review="${t.id}"]`);t.category=sel.value;t.subcategory=t.category==="غير مصنف"?"غير معروف":"تصنيف يدوي";t.confidence="CONFIRMED";t.classification_reason="تم تأكيده يدويًا";state.memory[merchantKey(t.merchant_raw)]={merchant_normalized:t.merchant_normalized,category:t.category,subcategory:t.subcategory};saveMemory();state.calculations=calculate(state.statement,state.transactions);buildReview();renderDashboard();});
}

function renderDashboard(){
  const c=state.calculations=calculate(state.statement,state.transactions), s=state.statement;
  $("#openingKpi").textContent=money(c.opening).replace(" ر.س","");$("#depositKpi").textContent=money(c.totalCredit).replace(" ر.س","");$("#withdrawKpi").textContent=money(c.totalDebit).replace(" ر.س","");$("#closingKpi").textContent=s.closing_balance==null?"—":money(c.closing).replace(" ر.س","");
  $("#depositCount").textContent=`${c.credits.length} عملية إيداع`;$("#withdrawCount").textContent=`${c.debits.length} عملية سحب`;$("#periodKpi").textContent=[s.statement_start,s.statement_end].filter(Boolean).join(" — ")||"الفترة غير محددة";
  const sortedCats=Object.entries(c.cat).sort((a,b)=>b[1].amount-a[1].amount); const top=sortedCats.slice(0,4); const major=top.reduce((x,[,v])=>x+v.amount,0);
  $("#majorAmount").textContent=money(major);$("#majorPct").textContent=`${c.totalDebit? (major/c.totalDebit*100).toFixed(1):0}% من إجمالي السحوبات`;
  $("#majorBreakdown").innerHTML=top.map(([k,v])=>`<div class="stat"><span>${esc(k)}</span><b>${money(v.amount)}</b></div>`).join("");
  drawDonut(sortedCats,c.totalDebit);drawBars(sortedCats);drawDaily();renderRecon();renderCategoryTables(sortedCats);renderCategoryDetails(sortedCats);renderMerchants();renderUnknown();renderAllTransactions();populateFilters();
  if(state.insights)renderInsights(); else renderFallbackInsights();
}

function drawDonut(sorted,total){let acc=0;const parts=[];sorted.forEach(([k,v],i)=>{const p=total?v.amount/total*100:0;parts.push(`${palette[i%palette.length]} ${acc}% ${acc+p}%`);acc+=p;});$("#ring").style.background=`conic-gradient(${parts.join(',')})`;$("#ringTotal").textContent=money(total);$("#legend").innerHTML=sorted.map(([k,v],i)=>`<div class="legendRow"><span class="dot" style="background:${palette[i%palette.length]}"></span><span>${esc(k)}</span><b>${money(v.amount)}</b></div>`).join('');}
function drawBars(sorted){const max=sorted[0]?.[1]?.amount||1;$("#bars").innerHTML=sorted.map(([k,v],i)=>`<div class="bar"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${v.amount/max*100}%;background:${palette[i%palette.length]}"></div></div><b>${money(v.amount)}</b></div>`).join('');}
function drawDaily(){const c=state.calculations,svg=$("#dailyChart"),data=Object.entries(c.daily).sort((a,b)=>a[0].localeCompare(b[0])),W=1120,H=260,p={l:52,r:18,t:15,b:42},max=Math.max(...data.map(x=>x[1]),1),iw=W-p.l-p.r,ih=H-p.t-p.b,muted=getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(),line=getComputedStyle(document.documentElement).getPropertyValue('--line').trim();let out='';for(let k=0;k<=4;k++){let y=p.t+ih*k/4;out+=`<line x1="${p.l}" x2="${W-p.r}" y1="${y}" y2="${y}" stroke="${line}"/><text x="${p.l-7}" y="${y+4}" text-anchor="end" font-size="10" fill="${muted}">${Math.round(max*(1-k/4)).toLocaleString('en-US')}</text>`;}const bw=iw/Math.max(data.length,1)*.62;data.forEach((d,i)=>{const bh=d[1]/max*ih,x=p.l+(i+.5)*iw/data.length-bw/2,y=p.t+ih-bh,col=d[1]>max*.55?'#E76F51':d[1]>max*.2?'#FFB703':'#6C63FF';out+=`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="3" fill="${col}"><title>${esc(d[0])}: ${money(d[1])}</title></rect>`;if(i%Math.max(1,Math.ceil(data.length/12))===0)out+=`<text x="${x+bw/2}" y="${H-16}" text-anchor="middle" font-size="10" fill="${muted}">${esc(d[0].slice(5)||d[0])}</text>`;});svg.innerHTML=out;}
function renderRecon(){const c=state.calculations,checks=[c.checks.balance,c.checks.bankDebit,c.checks.bankCredit].filter(x=>x!==null),ok=checks.every(Boolean);const b=$("#reconBox");b.classList.toggle("bad",!ok);b.innerHTML=ok?`<b>✓ Statement reconciled</b><br>Opening ${money(c.opening)} + Credits ${money(c.totalCredit)} − Debits ${money(c.totalDebit)} = ${c.closing==null?'—':money(c.closing)}`:`<b>⚠ Reconciliation issue</b><br>المحسوب: ${c.expected==null?'—':money(c.expected)} · رصيد الإقفال بالبنك: ${c.closing==null?'—':money(c.closing)} · الفرق: ${c.balanceDiff==null?'—':money(c.balanceDiff)}`;}
function renderCategoryTables(sorted){const c=state.calculations;$("#catTable").innerHTML=sorted.map(([k,v])=>`<tr><td>${esc(k)}</td><td class="money">${money(v.amount)}</td><td>${c.totalDebit?(v.amount/c.totalDebit*100).toFixed(2):'0.00'}%</td><td>${v.count}</td></tr>`).join('');const subs=Object.values(c.sub).sort((a,b)=>b.amount-a.amount);$("#subTable").innerHTML=subs.map(x=>`<tr><td>${esc(x.category)}</td><td>${esc(x.subcategory)}</td><td class="money">${money(x.amount)}</td><td>${x.count}</td></tr>`).join('');}
function renderCategoryDetails(sorted){const c=state.calculations;$("#categoryDetails").innerHTML=sorted.map(([cat,v],idx)=>{const tx=state.transactions.filter(t=>t.debit>0&&t.category===cat),subs=Object.values(c.sub).filter(x=>x.category===cat).sort((a,b)=>b.amount-a.amount);return `<details ${idx<3?'open':''}><summary><span>${esc(cat)}</span><b>${money(v.amount)} <span class="kfoot">(${(v.amount/c.totalDebit*100).toFixed(1)}%)</span></b></summary><div class="subchips">${subs.map(s=>`<div class="subchip"><span>${esc(s.subcategory)}</span><b>${money(s.amount)}</b></div>`).join('')}</div><div class="tableWrap"><table><thead><tr><th>التاريخ</th><th>الجهة</th><th>التفصيل</th><th>المبلغ</th><th>الثقة</th></tr></thead><tbody>${tx.map(t=>`<tr><td>${esc(t.date)}</td><td>${esc(t.merchant_normalized||t.merchant_raw)}</td><td>${esc(t.subcategory)}</td><td class="money">${money(t.debit)}</td><td>${confidenceBadge(t.confidence)}</td></tr>`).join('')}</tbody></table></div></details>`;}).join('');}
function renderMerchants(){const c=state.calculations,arr=Object.entries(c.merchant).sort((a,b)=>b[1].amount-a[1].amount);$("#merchantTable").innerHTML=arr.map(([m,v])=>`<tr><td>${esc(m)}</td><td class="money">${money(v.amount)}</td><td>${v.count}</td><td>${c.totalDebit?(v.amount/c.totalDebit*100).toFixed(2):0}%</td></tr>`).join('');}
function renderUnknown(){const c=state.calculations,rows=state.transactions.filter(t=>t.debit>0&&t.category==="غير مصنف");$("#coverageBox").innerHTML=`<b>التغطية: ${c.coverage.toFixed(2)}%</b><br>تم تصنيف ${money(c.classified)} · بقي ${money(c.unknown)} غير مصنف` ;$("#unknownTable").innerHTML=rows.length?rows.map(t=>`<tr><td>${esc(t.date)}</td><td>${esc(t.merchant_raw)}</td><td class="money">${money(t.debit)}</td><td>${esc(t.classification_reason)}</td></tr>`).join(''):`<tr><td colspan="4" class="empty">لا توجد عمليات غير مصنفة.</td></tr>`;}
function confidenceBadge(c){const cls=c==="CONFIRMED"||c==="HIGH"?'ok':c==="UNRESOLVED"||c==="LOW"?'bad':'warn';return `<span class="badge ${cls}">${esc(c)}</span>`;}
function populateFilters(){const s=$("#filterCat"),value=s.value;s.innerHTML='<option value="">كل الفئات</option>'+[...new Set(state.transactions.map(t=>t.category))].sort().map(c=>`<option>${esc(c)}</option>`).join('');s.value=value;}
function renderAllTransactions(){const q=$("#searchTx").value.toLowerCase().trim(),cat=$("#filterCat").value,type=$("#filterType").value,conf=$("#filterConfidence").value;const f=state.transactions.filter(t=>(!q||(t.merchant_raw+' '+t.merchant_normalized+' '+t.category+' '+t.subcategory).toLowerCase().includes(q))&&(!cat||t.category===cat)&&(!type||(type==='debit'?t.debit>0:t.credit>0))&&(!conf||t.confidence===conf));$("#allTx").innerHTML=f.map((t,i)=>`<tr><td>${i+1}</td><td>${esc(t.date)}</td><td>${esc(t.time)}</td><td><b>${esc(t.merchant_normalized||t.merchant_raw)}</b><div class="sourceRaw">${esc(t.original_description)}</div></td><td>${esc(t.category)}</td><td>${esc(t.subcategory)}</td><td class="money ${t.debit>0?'red':'green'}">${t.debit>0?'−':'+'}${money(t.debit||t.credit)}</td><td>${t.balance==null?'—':money(t.balance)}</td><td>${confidenceBadge(t.confidence)}</td></tr>`).join('');}

function summaryForAI(){const c=state.calculations,s=state.statement;return {period:{start:s.statement_start,end:s.statement_end},currency:s.currency,opening_balance:c.opening,closing_balance:c.closing,total_deposits:c.totalCredit,total_withdrawals:c.totalDebit,deposit_count:c.credits.length,withdrawal_count:c.debits.length,classification_coverage_pct:c.coverage,unclassified_amount:c.unknown,categories:Object.entries(c.cat).map(([category,v])=>({category,amount:v.amount,count:v.count,pct:c.totalDebit?round2(v.amount/c.totalDebit*100):0})).sort((a,b)=>b.amount-a.amount),top_merchants:Object.entries(c.merchant).map(([merchant,v])=>({merchant,amount:v.amount,count:v.count})).sort((a,b)=>b.amount-a.amount).slice(0,12),daily_spend:Object.entries(c.daily).map(([date,amount])=>({date,amount})).sort((a,b)=>b.amount-a.amount).slice(0,10),reconciled:Object.values(c.checks).filter(x=>x!==null).every(Boolean)};}
function renderInsights(){const x=state.insights;if(!x)return renderFallbackInsights();$("#insights").innerHTML=`<div class="insight"><b>${esc(x.headline)}</b><span>ملخص التحليل</span></div>`+(x.insights||[]).map(i=>`<div class="insight"><b>${esc(i.title)}</b>${esc(i.text)}</div>`).join('');}
function renderFallbackInsights(){const c=state.calculations;if(!c)return;const cats=Object.entries(c.cat).sort((a,b)=>b[1].amount-a[1].amount),top=cats[0];const daily=Object.entries(c.daily).sort((a,b)=>b[1]-a[1])[0];$("#insights").innerHTML=`<div class="insight"><b>أكبر فئة</b>${top?`${esc(top[0])}: ${money(top[1].amount)} (${(top[1].amount/c.totalDebit*100).toFixed(1)}%)`:'—'}</div><div class="insight"><b>أعلى يوم صرف</b>${daily?`${esc(daily[0])}: ${money(daily[1])}`:'—'}</div><div class="insight"><b>التغطية</b>${c.coverage.toFixed(2)}% من المصروفات مصنفة.</div>`;}

function exportCSV(){const headers=["date","time","merchant_raw","merchant_normalized","category","subcategory","debit","credit","balance","confidence","original_description"],lines=[headers.join(',')];state.transactions.forEach(t=>lines.push(headers.map(h=>'"'+String(t[h]??'').replaceAll('"','""')+'"').join(',')));download(new Blob(["\ufeff"+lines.join("\n")],{type:"text/csv;charset=utf-8"}),"statement-analysis.csv");}
function exportJSON(){download(new Blob([JSON.stringify({statement:state.statement,transactions:state.transactions,calculated:state.calculations,insights:state.insights},null,2)],{type:"application/json"}),"statement-analysis.json");}
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}


function loadDemo(){
  clearError();
  state.statement={bank_name:"بنك تجريبي",currency:"SAR",statement_start:"2026-08-27",statement_end:"2026-09-19",opening_balance:1400,closing_balance:875,bank_total_deposits:12000,bank_total_withdrawals:12525,bank_deposit_count:1,bank_withdrawal_count:12,warnings:[]};
  const demo=[
    ["2026-08-27","راتب",0,12000,13400,"دخل","إيداع","CONFIRMED"],
    ["2026-08-28","قسط تمويل",3200,0,10200,"ثابت","قسط التمويل","CONFIRMED"],
    ["2026-09-01","Ejar",3800,0,6400,"ثابت","الإيجار","CONFIRMED"],
    ["2026-09-03","SASCO",120,0,6280,"السيارة","وقود","HIGH"],
    ["2026-09-04","Space Cup",22,0,6258,"قهوة ومقاهي","قهوة","HIGH"],
    ["2026-09-05","Restaurant",85,0,6173,"مطاعم وأكل","مطعم","HIGH"],
    ["2026-09-08","تحويل إلى قريب",1000,0,5173,"تحويلات شخصية","تحويل إلى قريب","CONFIRMED"],
    ["2026-09-10","Pharmacy",175,0,4998,"الصحة والصيدليات","صيدلية","HIGH"],
    ["2026-09-12","Groceries",460,0,4538,"بقالة ومقاضي","مقاضي","HIGH"],
    ["2026-09-14","Tamara",1250,0,3288,"ثابت","تمارا / شراء مؤجل","CONFIRMED"],
    ["2026-09-16","Unknown Merchant",413,0,2875,"غير مصنف","غير معروف","UNRESOLVED"],
    ["2026-09-18","Shopping",2000,0,875,"تسوق وعناية","تسوق","MEDIUM"]
  ];
  state.transactions=demo.map((x,i)=>({id:`tx_${i+1}`,date:x[0],time:"",original_description:x[1],merchant_raw:x[1],merchant_normalized:x[1],debit:x[2],credit:x[3],balance:x[4],transaction_kind:x[3]>0?"deposit":"purchase",category:x[5],subcategory:x[6],confidence:x[7],classification_reason:x[7]==="UNRESOLVED"?"لم يتم التعرف على التاجر":"نموذج تجريبي"}));
  state.calculations=calculate(state.statement,state.transactions);
  state.insights={headline:"المصروفات الثابتة هي المحرك الأكبر للإنفاق في هذا المثال.",insights:[{title:"الالتزامات",text:"القسط والإيجار وتمارا تمثل الجزء الأكبر من المصروفات."},{title:"السيارة",text:"تم فصل الوقود عن بقية مصروفات السيارة."},{title:"التغطية",text:`${state.calculations.coverage.toFixed(2)}% من المصروفات مصنفة في النموذج.`}]};
  buildReview();renderDashboard();
  $("#uploadView").style.display="none";$("#dashboard").style.display="block";
  ["#printBtn","#csvBtn","#jsonBtn"].forEach(s=>$(s).classList.remove("hidden"));
  window.scrollTo({top:0,behavior:"smooth"});
}
