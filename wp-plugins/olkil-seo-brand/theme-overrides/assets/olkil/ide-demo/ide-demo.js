/* OLKIL IDE demo widget — lazy-loaded by template-parts/olkil/sections/demo.php. Exposes window.olkilIdeMount(host, logoUrl). */
(function(){
"use strict";
if(window.olkilIdeMount)return;

function S(id,d){return '<symbol id="olk-'+id+'" viewBox="0 0 24 24">'+d+'</symbol>';}
const SPRITE='<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'+
 S("files",'<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>')+
 S("search",'<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>')+
 S("git",'<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>')+
 S("bug",'<path d="m8 2 1.9 1.9M14.1 3.9 16 2M9 7.1v-1a3 3 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.5 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M21 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/>')+
 S("ext",'<rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1" transform="rotate(14 18 6)"/>')+
 S("gear",'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>')+
 S("x",'<path d="M18 6 6 18M6 6l12 12"/>')+
 S("plus",'<path d="M5 12h14M12 5v14"/>')+
 S("min",'<path d="M5 12h14"/>')+
 S("max",'<rect x="5" y="5" width="14" height="14" rx="1"/>')+
 S("cr",'<path d="m9 18 6-6-6-6"/>')+
 S("cd",'<path d="m6 9 6 6 6-6"/>')+
 S("hist",'<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2"/>')+
 S("help",'<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>')+
 S("exp",'<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>')+
 S("up",'<path d="M12 19V5M5 12l7-7 7 7"/>')+
 S("trash",'<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>')+
 S("newf",'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 12v6M9 15h6"/>')+
 S("err",'<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>')+
 S("warn",'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>')+
 S("play",'<path d="m6 3 14 9-14 9z"/>')+
 S("bell",'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>')+
 '</defs></svg>';

const I=n=>'<svg class="i" aria-hidden="true"><use href="#olk-'+n+'"/></svg>';
const B=(id,title,icon)=>'<button type="button" class="ib" id="'+id+'" title="'+title+'" aria-label="'+title+'">'+I(icon)+'</button>';

function markup(logo){
 return '<div class="olkide" id="olkIde">'+SPRITE+
 '<div class="titlebar">'+
  '<img src="'+logo+'" alt="OLKIL" width="18" height="18" decoding="async">'+
  '<div class="menu" id="olkMenu"><span data-mn="File">File</span><span data-mn="Edit">Edit</span><span data-mn="Selection">Selection</span><span data-mn="View">View</span><span data-mn="Go">Go</span><span data-mn="Terminal">Terminal</span><span data-mn="Help">Help</span></div>'+
  '<div class="tt" id="olkTitle">Pricing.tsx - t2</div>'+
  '<div class="wc">'+B("olkWMin","Minimize","min")+B("olkWMax","Maximize","max")+B("olkWX","Close","x")+'</div>'+
 '</div>'+
 '<div class="main" id="olkMain">'+
  '<nav class="act" id="olkAct">'+
   '<button type="button" class="ib on" data-v="ex" title="Explorer" aria-label="Explorer">'+I("files")+'</button>'+
   '<button type="button" class="ib" data-v="se" title="Search" aria-label="Search">'+I("search")+'</button>'+
   '<button type="button" class="ib" data-v="gi" title="Source Control" aria-label="Source Control">'+I("git")+'</button>'+
   '<button type="button" class="ib" data-v="de" title="Run and Debug" aria-label="Run and Debug">'+I("bug")+'</button>'+
   '<button type="button" class="ib" data-v="xt" title="Extensions" aria-label="Extensions">'+I("ext")+'</button>'+
   '<div class="sp"></div>'+B("olkGear","Manage","gear")+
  '</nav>'+
  '<aside class="side" id="olkSide"></aside>'+
  '<div class="center">'+
   '<div class="tabs" id="olkTabs"></div>'+
   '<div class="crumb" id="olkCrumb"></div>'+
   '<div class="code" id="olkCode"><pre class="gut" id="olkGut"></pre><div class="stack"><pre id="olkPre"></pre><textarea class="ed" id="olkTA" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Code editor"></textarea></div></div>'+
   '<div class="panel" id="olkPanel">'+
    '<div class="ph" id="olkPH"><span data-p="olkProb">PROBLEMS <b class="bd">27</b></span><span data-p="olkOut">OUTPUT</span><span data-p="olkDbg">DEBUG CONSOLE</span><span class="on" data-p="olkTerm">TERMINAL</span>'+
     '<div class="r">'+B("olkPNew","New terminal","plus")+B("olkPClr","Clear","trash")+B("olkPX","Close panel","x")+'</div></div>'+
    '<div class="pb mono" id="olkProb"></div><div class="pb mono" id="olkOut"></div><div class="pb mono" id="olkDbg"></div><div class="pb mono on" id="olkTerm"></div>'+
   '</div>'+
  '</div>'+
  '<aside class="chat" id="olkChat">'+
   '<div class="chead"><img src="'+logo+'" alt="" width="16" height="16" decoding="async"><b>OLKIL</b><em id="olkState">Agent Ready</em>'+
    '<div class="r">'+B("olkCHist","History","hist")+B("olkCNew","New chat","plus")+B("olkCHelp","Help","help")+B("olkCExp","Expand","exp")+B("olkCMin","Hide chat","min")+'</div></div>'+
   '<div class="modes" id="olkModes"><button type="button" class="on" data-m="Agent">Agent</button><button type="button" data-m="Ask">Ask</button><button type="button" data-m="Plan">Plan</button>'+
    '<select id="olkModel" aria-label="Model"><option>DeepSeek V4 Flash · CLOUD</option><option>Claude Sonnet · CLOUD</option><option>GPT-5 mini · CLOUD</option><option>Qwen Coder · LOCAL</option><option>Llama 3 · LOCAL</option></select></div>'+
   '<div class="msgs" id="olkMsgs" aria-live="polite"></div>'+
   '<div class="inp"><div class="men" id="olkMen" style="display:none"></div>'+
    '<textarea id="olkIn" placeholder="Add a modern dashboard section..." aria-label="Message OLKIL"></textarea>'+
    '<div class="row"><span><a id="olkAt" role="button" tabindex="0">@ mention</a> · Enter send · Shift+Enter newline</span><button type="button" class="send" id="olkSend" aria-label="Send">'+I("up")+'</button></div></div>'+
   '<div class="hist" id="olkHist" style="display:none"></div>'+
  '</aside>'+
 '</div>'+
 '<div class="status" id="olkStatus">'+
  '<span id="olkSProb">'+I("err")+'26 '+I("warn")+'1</span><span class="sp"></span>'+
  '<span id="olkSLive">Go Live</span><span id="olkSLn">Ln 1, Col 1</span><span id="olkSSp">Spaces: 2</span><span id="olkSEnc">UTF-8</span><span id="olkSEol">CRLF</span><span id="olkSLang">TypeScript React</span>'+
  '<span id="olkSChat" title="Toggle OLKIL chat">'+I("bell")+'</span>'+
 '</div>'+
 '<div class="toast" id="olkToast"></div>'+
 '<div class="closed"><button type="button" id="olkReopen">Reopen OLKIL</button></div>'+
 '</div>';
}

window.olkilIdeMount=function(host,logo){
if(!host||host.querySelector(".olkide"))return;
host.innerHTML=markup(logo||"");
const R=host.querySelector(".olkide"),$=id=>document.getElementById(id);
const esc=x=>x.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const focusNS=el=>{try{el.focus({preventScroll:true});}catch(e){el.focus();}};
function toast(t){const e=$("olkToast");e.textContent=t;e.classList.add("on");clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove("on"),1800);}

/* ---------- demo data ---------- */
const FILES={
"Contact.tsx":'export default function Contact() {\n  return (\n    <section id="contact" className="py-20">\n      <h2 className="text-3xl font-bold">Contact us</h2>\n      <form className="mt-6 grid gap-4">\n        <input placeholder="Your email" />\n        <button className="btn-primary">Send</button>\n      </form>\n    </section>\n  );\n}',
"CTA.tsx":'export default function CTA() {\n  return (\n    <div className="rounded-2xl bg-slate-900 p-12">\n      <h2>Ready to ship faster?</h2>\n      <a href="#pricing" className="btn">Get started</a>\n    </div>\n  );\n}',
"Features.tsx":'const features = ["Fast", "Secure", "Simple"];\n\nexport default function Features() {\n  return (\n    <ul className="grid grid-cols-3 gap-6">\n      {features.map((f) => (\n        <li key={f}>{f}</li>\n      ))}\n    </ul>\n  );\n}',
"Footer.tsx":'export default function Footer() {\n  return <footer className="py-8 text-center">&copy; 2026 Acme Inc.</footer>;\n}',
"Hero.tsx":'export default function Hero() {\n  return (\n    <header className="py-24 text-center">\n      <h1 className="text-5xl font-extrabold">Build something people love</h1>\n      <p className="mt-4 text-slate-500">One tool. Zero friction.</p>\n    </header>\n  );\n}',
"Navbar.tsx":'export default function Navbar() {\n  return (\n    <nav className="flex justify-between p-4">\n      <span>Acme</span>\n      <a href="#pricing">Pricing</a>\n    </nav>\n  );\n}',
"Pricing.tsx":'import { plans } from "../data";\n\nexport default function Pricing() {\n  return (\n    <section id="pricing">\n      {plans.map((plan) => (\n        <div\n          key={plan.name}\n          className={`rounded-2xl p-6 ${\n            plan.highlighted\n              ? "border-2 border-primary-600"\n              : "border border-blue-100"\n          }`}\n        >\n          {plan.highlighted && (\n            <span className="absolute -top-3.5">Most popular</span>\n          )}\n          <h3 className="text-lg font-bold">{plan.name}</h3>\n          <p className="mt-1.5 text-sm">{plan.description}</p>\n          <span className="text-4xl font-extrabold">{plan.price}</span>\n        </div>\n      ))}\n    </section>\n  );\n}',
"Services.tsx":'export default function Services() {\n  return <section id="services">Our services</section>;\n}',
"Stats.tsx":'const stats = [{ n: "10k+", l: "Users" }, { n: "99.9%", l: "Uptime" }];\n\nexport default function Stats() {\n  return stats.map((s) => <div key={s.l}>{s.n} {s.l}</div>);\n}',
"App.tsx":'import Navbar from "./components/Navbar";\nimport Hero from "./components/Hero";\nimport Pricing from "./components/Pricing";\n\nexport default function App() {\n  return (\n    <>\n      <Navbar />\n      <Hero />\n      <Pricing />\n    </>\n  );\n}',
"data.ts":'export const plans = [\n  { name: "Starter", price: "$0", highlighted: false },\n  { name: "Pro", price: "$19", highlighted: true },\n  { name: "Team", price: "$49", highlighted: false },\n];',
"index.css":'@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nbody {\n  font-family: Inter, sans-serif;\n  background: #fff;\n}',
"main.tsx":'import { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\n\ncreateRoot(document.getElementById("root")!).render(<App />);',
".gitignore":"node_modules\ndist\n.env"
};
const PARENT={".olkil":"T2",node_modules:"T2",dist:"T2",src:"T2",components:"src"};
const TREE=[["d","T2",0],["d",".olkil",1],["d","node_modules",1],["d","dist",1],["d","src",1],["d","components",2],
 ...["Contact.tsx","CTA.tsx","Features.tsx","Footer.tsx","Hero.tsx","Navbar.tsx","Pricing.tsx","Services.tsx","Stats.tsx"].map(n=>["f",n,3,"components"]),
 ...["App.tsx","data.ts","index.css","main.tsx"].map(n=>["f",n,2,"src"]),["f",".gitignore",1,"T2"]];
const openF={T2:1,src:1,components:1};
let open=["Contact.tsx","data.ts","Hero.tsx","Pricing.tsx"],cur="Pricing.tsx",view="ex",creating=false;
const dirty=new Set(),git=new Set(["Pricing.tsx","data.ts"]),inst=new Set(["Prettier"]);
const L={sb:1,chat:1,panel:1,wide:0};
let spaces=2,live=false;

/* ---------- syntax highlight ---------- */
const KW=/^(import|export|default|function|return|const|from|let|var|if|else|class|new)$/;
function hl(line){
  return line.replace(/(\/\/.*$)|("[^"]*"|`[^`]*`|'[^']*')|(<\/?[A-Za-z][\w.]*|\/>|>)|([A-Za-z_@$][\w$]*)|(\d+)|([\s\S])/g,(m,c,s,t,w,n)=>{
    if(c)return'<span class="c">'+esc(c)+'</span>';if(s)return'<span class="s">'+esc(s)+'</span>';
    if(t)return'<span class="t">'+esc(t)+'</span>';if(w)return KW.test(w)?'<span class="k">'+w+'</span>':esc(w);
    if(n)return'<span class="n">'+n+'</span>';return esc(m);});
}
function fileIcon(n){return n.endsWith(".css")?'<span class="cs">#</span>':/\.tsx?$/.test(n)?'<span class="ts">TS</span>':'<span class="jt">&#9679;</span>';}

/* ---------- layout / window ---------- */
function layout(){
  $("olkMain").style.gridTemplateColumns="48px "+(L.sb?"240px":"0px")+" 1fr "+(L.chat?(L.wide?"460px":"350px"):"0px");
  $("olkSide").classList.toggle("h",!L.sb);$("olkChat").classList.toggle("h",!L.chat);
  $("olkPanel").style.display=L.panel?"":"none";
}
const tog=k=>()=>{L[k]=L[k]?0:1;layout();};
$("olkWMin").onclick=()=>R.classList.toggle("mini");
$("olkWMax").onclick=()=>R.classList.toggle("max");
$("olkWX").onclick=()=>R.classList.add("cl");$("olkReopen").onclick=()=>R.classList.remove("cl");
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&R.classList.contains("max"))R.classList.remove("max");});

/* ---------- menus ---------- */
const MENUS={
 File:[["New File","",()=>{setView("ex");creating=true;renderSide();}],["Save","Ctrl+S",save],["Close Tab","",()=>cur&&closeTab(cur)]],
 Edit:[["Undo","Ctrl+Z",()=>{focusNS($("olkTA"));document.execCommand("undo");}],["Redo","Ctrl+Y",()=>{focusNS($("olkTA"));document.execCommand("redo");}]],
 Selection:[["Select All","Ctrl+A",()=>{focusNS($("olkTA"));$("olkTA").select();}]],
 View:[["Toggle Sidebar","",tog("sb")],["Toggle Panel","",tog("panel")],["Toggle OLKIL Chat","",tog("chat")]],
 Go:[["Go to App.tsx","",()=>show("App.tsx")],["Go to Pricing.tsx","",()=>show("Pricing.tsx")],["Go to Line 5","",()=>gotoLine(5)]],
 Terminal:[["New Terminal","",()=>{panelTab("olkTerm");newTerm();}],["Clear Terminal","",()=>{term.innerHTML="";prompt();}]],
 Help:[["Welcome","",()=>toast("Welcome to OLKIL \u2728")],["About OLKIL","",()=>toast("OLKIL IDE v1.0 (demo)")]],
 Gear:[["Toggle Sidebar","",tog("sb")],["Toggle Panel","",tog("panel")],["Toggle OLKIL Chat","",tog("chat")],["Command Palette","Ctrl+Shift+P",()=>toast("Command palette (demo)")]]
};
function closeDD(){const d=$("olkDD");if(d)d.remove();R.querySelectorAll(".menu span.on").forEach(s=>s.classList.remove("on"));}
function openMenu(el,name,above){
  closeDD();const d=document.createElement("div");d.className="dd";d.id="olkDD";
  MENUS[name].forEach(([l,k,f])=>{const b=document.createElement("div");b.innerHTML="<span>"+l+"</span><i>"+k+"</i>";b.onclick=e=>{e.stopPropagation();closeDD();f();};d.appendChild(b);});
  const r=el.getBoundingClientRect(),o=R.getBoundingClientRect();
  d.style.left=(above?r.right-o.left:r.left-o.left)+"px";R.appendChild(d);d.style.top=(above?r.top-o.top-d.offsetHeight:r.bottom-o.top+2)+"px";el.classList.add("on");
}
$("olkMenu").onclick=e=>{const s=e.target.closest("[data-mn]");if(!s)return;e.stopPropagation();openMenu(s,s.dataset.mn);};
$("olkGear").onclick=e=>{e.stopPropagation();openMenu(e.currentTarget,"Gear",true);};
document.addEventListener("click",closeDD);

/* ---------- sidebar views ---------- */
function setView(v){view=v;R.querySelectorAll("#olkAct [data-v]").forEach(b=>b.classList.toggle("on",b.dataset.v===v));if(!L.sb){L.sb=1;layout();}renderSide();}
$("olkAct").onclick=e=>{const b=e.target.closest("[data-v]");if(!b)return;if(b.dataset.v===view&&L.sb){L.sb=0;layout();return;}setView(b.dataset.v);};
const vis=p=>{while(p){if(!openF[p])return false;p=PARENT[p];}return true;};
function renderSide(){
  const s=$("olkSide");
  if(view==="ex"){
    let h='<div class="sh"><span>EXPLORER</span><div>'+B("olkExNew","New File","newf")+B("olkExCol","Collapse folders","min")+'</div></div>';
    h+='<div class="sec">'+I("cd")+'OPENED EDITORS</div>';
    open.forEach(n=>h+='<div class="f" data-f="'+n+'" style="padding-left:22px">'+fileIcon(n)+n+(dirty.has(n)?"<em>&#9679;</em>":"")+'</div>');
    h+='<div class="sec" style="margin-top:6px">'+I("cd")+'T2</div>';
    TREE.slice(1).forEach(([t,n,l,p])=>{
      const par=t==="d"?PARENT[n]:p;if(!vis(par))return;
      if(t==="d")h+='<div class="f d" data-d="'+n+'" style="padding-left:'+(8+l*12)+'px">'+I(openF[n]?"cd":"cr")+n+'</div>';
      else h+='<div class="f '+(n===cur?"on":"")+'" data-f="'+n+'" style="padding-left:'+(10+l*12+8)+'px">'+fileIcon(n)+n+(dirty.has(n)?"<em>&#9679;</em>":git.has(n)?"<em>M</em>":"")+'</div>';
      if(n==="components"&&openF.components&&creating)h+='<div class="f" style="padding-left:56px">'+fileIcon("a.tsx")+'<input id="olkNewIn" placeholder="NewFile.tsx"></div>';
    });
    s.innerHTML=h;
    const ni=$("olkNewIn");if(ni){focusNS(ni);ni.onkeydown=e=>{if(e.key==="Escape"){creating=false;renderSide();}if(e.key==="Enter"&&ni.value.trim()){const n=mkFile(ni.value.trim());creating=false;show(n);}};ni.onblur=()=>{creating=false;setTimeout(renderSide,100);};}
    $("olkExNew").onclick=()=>{openF.components=openF.src=1;creating=true;renderSide();};
    $("olkExCol").onclick=()=>{Object.keys(openF).forEach(k=>k!=="T2"&&(openF[k]=0));renderSide();};
  }else if(view==="se"){
    s.innerHTML='<div class="sh"><span>SEARCH</span></div><div class="pad"><input class="sin" id="olkSeIn" placeholder="Search in files..."></div><div id="olkSeRes"></div>';
    $("olkSeIn").oninput=doSearch;focusNS($("olkSeIn"));
  }else if(view==="gi"){
    let h='<div class="sh"><span>SOURCE CONTROL</span></div><div class="pad"><input class="sin" id="olkGiMsg" placeholder="Message (commit on main)"><button type="button" class="btn" id="olkGiBtn">Commit</button></div><div class="sec">'+I("cd")+'CHANGES ('+git.size+')</div>';
    git.forEach(n=>h+='<div class="f" data-f="'+n+'" style="padding-left:22px">'+fileIcon(n)+n+'<em>'+(n==="Dashboard.tsx"?"U":"M")+'</em></div>');
    if(!git.size)h+='<div class="pad" style="color:var(--mut)">No changes detected.</div>';
    s.innerHTML=h;$("olkGiBtn").onclick=()=>{if(!git.size)return toast("Nothing to commit");const m=$("olkGiMsg").value.trim()||"update";git.clear();toast('Committed: "'+m+'"');out("[git] commit: "+m,"ok");renderSide();};
  }else if(view==="de"){
    s.innerHTML='<div class="sh"><span>RUN AND DEBUG</span></div><div class="pad"><button type="button" class="btn" id="olkDeRun">'+I("play")+' Run and Debug</button></div><div class="sec">'+I("cd")+'BREAKPOINTS</div><div class="f" style="padding-left:22px"><span class="er">&#9679;</span> Pricing.tsx : 12</div><div class="f" style="padding-left:22px"><span class="er">&#9679;</span> App.tsx : 8</div><div class="sec">'+I("cd")+'CALL STACK</div><div class="pad" style="color:var(--mut)">Not running</div>';
    $("olkDeRun").onclick=()=>{panelTab("olkDbg");dbg("Debugger attached to localhost:5173");dbg("Hit breakpoint at Pricing.tsx:12");dbg("Continuing...");};
  }else{
    const E=[["Prettier","Code formatter"],["ESLint","Find and fix problems"],["Tailwind CSS","Autocomplete for Tailwind"],["GitLens","Supercharge Git"],["Live Server","Launch a local server"]];
    s.innerHTML='<div class="sh"><span>EXTENSIONS</span></div>'+E.map(([n,d])=>'<div class="ext"><div class="box">'+n[0]+'</div><div style="flex:1;min-width:0"><b>'+n+'</b><small>'+d+'</small></div><button type="button" class="btn g" data-e="'+n+'">'+(inst.has(n)?"Installed":"Install")+'</button></div>').join("");
    s.querySelectorAll("[data-e]").forEach(b=>b.onclick=()=>{const n=b.dataset.e;inst.has(n)?inst.delete(n):inst.add(n);toast((inst.has(n)?"Installed ":"Uninstalled ")+n);renderSide();});
  }
}
function doSearch(){
  const q=$("olkSeIn").value.trim().toLowerCase(),r=$("olkSeRes");if(!q){r.innerHTML="";return;}
  let h="";
  Object.keys(FILES).forEach(n=>{const hits=[];FILES[n].split("\n").forEach((l,i)=>l.toLowerCase().includes(q)&&hits.push([i+1,l]));
    if(hits.length){h+='<div class="sec">'+I("cd")+n+' <em style="margin-left:auto;font-style:normal;color:var(--mut)">'+hits.length+'</em></div>';
      hits.slice(0,5).forEach(([i,l])=>h+='<div class="f" data-f="'+n+'" data-l="'+i+'" style="padding-left:22px;color:var(--mut)">'+esc(l.trim().slice(0,40))+'</div>');}});
  r.innerHTML=h||'<div class="pad" style="color:var(--mut)">No results.</div>';
}
$("olkSide").onclick=e=>{
  const d=e.target.closest("[data-d]");if(d){openF[d.dataset.d]=!openF[d.dataset.d];renderSide();return;}
  const f=e.target.closest("[data-f]");if(f){show(f.dataset.f);if(f.dataset.l)gotoLine(+f.dataset.l);}
};
function mkFile(name,code){
  name=name.replace(/[^\w.-]/g,"");if(!name)name="NewFile";
  if(!/\.\w+$/.test(name))name+=".tsx";if(FILES[name])return name;
  const base=name.replace(/\.\w+$/,"");
  FILES[name]=code||'export default function '+base+'() {\n  return <div>'+base+'</div>;\n}';
  TREE.push(["f",name,3,"components"]);git.add(name);log("olkOut","Created "+name);return name;
}

/* ---------- editor ---------- */
const ta=$("olkTA");
function paint(){
  if(!cur){$("olkPre").innerHTML="";$("olkGut").textContent="";ta.value="";ta.disabled=true;$("olkCrumb").textContent="";$("olkTitle").textContent="t2 - OLKIL";return;}
  ta.disabled=false;const t=FILES[cur];
  $("olkPre").innerHTML=t.split("\n").map(hl).join("\n")+"\n";
  $("olkGut").textContent=t.split("\n").map((_,i)=>i+1).join("\n")+"\n";
  $("olkTitle").textContent=cur+" - t2";$("olkCrumb").textContent="src > components > "+cur;
}
function renderTabs(){
  $("olkTabs").innerHTML=open.map(n=>'<div class="tab '+(n===cur?"on":"")+'" data-f="'+n+'">'+fileIcon(n)+n+'<b data-x="'+n+'">'+(dirty.has(n)?"&#9679;":"&times;")+'</b></div>').join("");
}
function refreshSide(){if(view==="ex"||view==="gi")renderSide();}
function show(f){if(!open.includes(f))open.push(f);cur=f;ta.value=FILES[f];paint();renderTabs();refreshSide();cursor();}
function closeTab(n){open=open.filter(o=>o!==n);if(cur===n){cur=open[open.length-1]||null;if(cur)ta.value=FILES[cur];}paint();renderTabs();refreshSide();}
function save(){if(!cur)return;dirty.delete(cur);renderTabs();refreshSide();toast("Saved "+cur);log("olkOut","Saved "+cur);}
$("olkTabs").onclick=e=>{const x=e.target.closest("[data-x]");if(x){closeTab(x.dataset.x);return;}const t=e.target.closest("[data-f]");if(t)show(t.dataset.f);};
function cursor(){const v=ta.value.slice(0,ta.selectionStart).split("\n");$("olkSLn").textContent="Ln "+v.length+", Col "+(v[v.length-1].length+1);}
function gotoLine(n){if(!cur)return;const ls=FILES[cur].split("\n");let o=0;for(let i=0;i<n-1&&i<ls.length;i++)o+=ls[i].length+1;focusNS(ta);ta.setSelectionRange(o,o+(ls[n-1]||"").length);$("olkCode").scrollTop=Math.max(0,(n-4)*20);cursor();}
ta.addEventListener("input",()=>{FILES[cur]=ta.value;if(!dirty.has(cur)){dirty.add(cur);git.add(cur);renderTabs();refreshSide();}paint();cursor();});
ta.addEventListener("keydown",e=>{
  if(e.key==="Tab"){e.preventDefault();const s=ta.selectionStart,p=" ".repeat(spaces);ta.setRangeText(p,s,ta.selectionEnd,"end");ta.dispatchEvent(new Event("input"));}
  if((e.ctrlKey||e.metaKey)&&e.key==="s"){e.preventDefault();save();}
});
["keyup","click"].forEach(ev=>ta.addEventListener(ev,cursor));

/* ---------- panel ---------- */
function panelTab(id){L.panel=1;layout();R.querySelectorAll("#olkPH>span").forEach(s=>s.classList.toggle("on",s.dataset.p===id));["olkProb","olkOut","olkDbg","olkTerm"].forEach(i=>$(i).classList.toggle("on",i===id));}
$("olkPH").onclick=e=>{const s=e.target.closest("[data-p]");if(s)panelTab(s.dataset.p);};
$("olkPX").onclick=()=>{L.panel=0;layout();};
$("olkPClr").onclick=()=>{const on=R.querySelector(".pb.on");if(on.id==="olkTerm"){on.innerHTML="";prompt();}else if(on.id!=="olkProb")on.innerHTML="";};
$("olkPNew").onclick=()=>{panelTab("olkTerm");newTerm();};
function log(id,t,c){const b=$(id),d=document.createElement("div");if(c)d.className=c;d.textContent=t;b.appendChild(d);b.scrollTop=1e9;}
const out=(t,c)=>log("olkOut",t,c),dbg=(t,c)=>log("olkDbg",t,c);
(function(){const M=["'plan' is declared but never used.","Property 'description' does not exist on type 'Plan'.","Cannot find module './components/Dashboard'.","JSX element implicitly has type 'any'."],F=["Pricing.tsx","data.ts","App.tsx","Features.tsx","Contact.tsx"];
 let h="";for(let i=0;i<27;i++){const w=i===26;h+='<div class="pr" data-f="'+F[i%5]+'" data-l="'+(i%9+3)+'"><span class="'+(w?"wa":"er")+'">'+I(w?"warn":"err")+'</span>'+(w?"Unused variable 'temp'.":M[i%4])+' <small>'+F[i%5]+' ['+(i%9+3)+']</small></div>';}
 $("olkProb").innerHTML=h;
 $("olkProb").onclick=e=>{const r=e.target.closest("[data-f]");if(r){show(r.dataset.f);gotoLine(+r.dataset.l);}};
 out("[OLKIL] Extension host started");out("[vite] connected.","ok");dbg("Debug console ready.");})();
$("olkSProb").onclick=()=>panelTab("olkProb");
const term=$("olkTerm");
function prompt(){const d=document.createElement("div");d.innerHTML='PS C:\\z\\t2&gt; <input spellcheck="false" aria-label="Terminal input">';term.appendChild(d);const i=d.querySelector("input");
  i.onkeydown=e=>{if(e.key!=="Enter")return;const v=i.value.trim();i.replaceWith(document.createTextNode(v));run(v);};}
term.onclick=()=>{const l=term.querySelector("input");if(l&&!window.getSelection().toString())focusNS(l);};
function tout(t,c){const d=document.createElement("div");if(c)d.className=c;d.textContent=t;term.appendChild(d);}
function newTerm(){tout("--- new terminal ---","ok");prompt();}
function run(v){
  if(v==="clear"||v==="cls")term.innerHTML="";
  else if(v==="ls"||v==="dir")tout("src  dist  node_modules  package.json");
  else if(v.startsWith("npm run dev")){tout("VITE ready in 312 ms","ok");tout("Local: http://localhost:5173/","ok");}
  else if(v==="help")tout("try: ls, clear, npm run dev, git status, whoami");
  else if(v==="git status")tout(git.size?"modified: "+[...git].join(", "):"nothing to commit, working tree clean");
  else if(v==="whoami")tout("olkil-user");
  else if(v)tout("'"+v+"' is not recognized (demo terminal) - type help","er");
  prompt();term.scrollTop=1e9;const l=term.querySelector("input");if(l)focusNS(l);
}
prompt();

/* ---------- status bar ---------- */
$("olkSLive").onclick=()=>{live=!live;$("olkSLive").textContent=live?"Port: 5500":"Go Live";toast(live?"Live server started":"Live server stopped");out(live?"Server started at http://127.0.0.1:5500":"Server stopped",live?"ok":"");};
$("olkSSp").onclick=()=>{spaces=spaces===2?4:2;$("olkSSp").textContent="Spaces: "+spaces;toast("Indent size: "+spaces);};
$("olkSEnc").onclick=()=>toast("Encoding: UTF-8");$("olkSEol").onclick=()=>{const e=$("olkSEol");e.textContent=e.textContent==="CRLF"?"LF":"CRLF";};
$("olkSLang").onclick=()=>toast("Language mode: TypeScript React");$("olkSChat").onclick=tog("chat");

/* ---------- chat ---------- */
const msgs=$("olkMsgs"),inp=$("olkIn");let mode="Agent";const sessions=[];
function add(t,who,chip){const d=document.createElement("div");d.className="m "+who;d.textContent=t;
  if(chip){const c=document.createElement("div");c.className="chip";c.innerHTML=fileIcon(chip)+chip;c.onclick=()=>show(chip);d.appendChild(c);}
  msgs.appendChild(d);msgs.scrollTop=1e9;return d;}
function greet(){msgs.innerHTML="";add("Hey! \ud83d\udc4b I'm OLKIL, your AI coding agent. What would you like to build today? \u2728","bot");}greet();
const DASH='import Stats from "./Stats";\n\nexport default function Dashboard() {\n  return (\n    <div className="grid grid-cols-[220px_1fr] min-h-screen">\n      <aside className="p-6 bg-slate-900 text-white">Overview</aside>\n      <main className="p-8">\n        <h1 className="text-2xl font-bold">Dashboard</h1>\n        <Stats />\n      </main>\n    </div>\n  );\n}';
const KEYS=[
 [/\b(bug|bugs|error|errors|fix|issue|problem|crash)\b/,["Found the bug \ud83d\udc1b A missing key prop. Fixed it, 0 problems now!","Fix applied \u2705 All 27 problems resolved, the build is clean."],1],
 [/\b(pricing|price|plans?)\b/,["Done \ud83d\udc96 Added a 'Most popular' badge and a hover glow to the pricing cards."]],
 [/how are (you|u)|how r u|kaise ho|kese ho|kaisa hai|kaise hai|kya haal/,["I'm doing great, thanks for asking! \ud83d\ude04 What are we shipping today?"]],
 [/who are (you|u)|what are you|kaun ho|kon ho|tum kya ho|your name|tumhara naam|aapka naam/,["I'm OLKIL \ud83e\udd16 your AI coding agent. I write code, fix bugs and refactor, all in one place."]],
 [/what can (you|u) do|kya kar sakte|kya kya kar|help me|madad/,["Plenty! \ud83d\ude80 I can build components, fix bugs, explain code, write tests and refactor. Try: 'add a dashboard section'."]],
 [/\b(hi+|hello+|helo|hlo|hey+|hii+|namaste|namaskar|yo|hola)\b/,["Hey there! \ud83d\udc4b I'm OLKIL. What should we build today?","Hello! \ud83d\ude0a Want to write some code, fix a bug or add a new feature?","Hi! \u2728 I'm ready. Give me any task, a component, a bug fix or a refactor."]],
 [/\b(thanks|thank|thx|ty|shukriya|dhanyavad|dhanyawad)\b/,["Anytime! \ud83e\udd17 Just let me know if you need anything else."]],
 [/\b(bye|goodbye|see you|alvida|tata)\b/,["Bye! \ud83d\udc4b Happy coding. I'm here whenever you need me."]],
 [/^(ok|okay|okk|nice|great|cool|awesome|good|badhiya|mast)\b/,["Great! \ud83d\ude0e What's next?"]],
 [/\b(refactor|clean ?up|optimi[sz]e|improve)\b/,["Refactor complete \ud83e\uddf9 The code is now cleaner, smaller and faster.","Done \u2728 Removed duplicate logic and split up the components."],1],
 [/\b(test|tests|testing)\b/,["Tests written \ud83e\uddea 12 passing, 0 failing. Coverage is now 94%!"],1],
 [/\b(explain|samjha|samjhao|kya hai|what is|what does)\b/,["In simple terms \ud83d\udca1 this component maps over the plans array and renders a card for each plan. The highlighted plan gets a special border."],1],
 [/\b(make|create|build|add|banao|bana do|generate|design)\b/,["On it \ud83d\ude80 The component is built and fully responsive with Tailwind. Check the preview!","Done \u2728 The new component is ready and imported into App.tsx.","Great idea! \ud83c\udf38 The component is ready and styled."]]
];
const RANDOM=["Done \u2728 Changes applied, take a look at the preview!","Interesting! \ud83e\udde0 Let me make a quick plan first, then write the code.","Sure thing \ud83d\ude80 All done, 2 files updated.","Nice request \ud83d\udc96 Changes applied, give them a quick review!"];
const pick=a=>a[Math.floor(Math.random()*a.length)];
function send(){
  const v=inp.value.trim();if(!v)return;inp.value="";hideMen();add(v,"me");
  $("olkState").textContent=mode+" Thinking...";
  const t=add("","bot typing");t.innerHTML="<i></i><i></i><i></i>";
  setTimeout(()=>{
    t.className="m bot";t.innerHTML="";const low=v.toLowerCase();let chip=null,r;
    const men=v.match(/@([\w.]+)/);
    if(/dashboard/.test(low)&&mode==="Agent"){
      chip=mkFile("Dashboard.tsx",DASH);
      if(FILES["App.tsx"].indexOf("Dashboard")<0)FILES["App.tsx"]=FILES["App.tsx"].replace('import Pricing','import Dashboard from "./components/Dashboard";\nimport Pricing').replace("<Pricing />","<Pricing />\n      <Dashboard />");
      git.add("App.tsx");
      r="Dashboard section ready! \ud83d\udcca Created Dashboard.tsx and added it to App.tsx.";renderSide();if(cur==="App.tsx"){ta.value=FILES[cur];paint();}
    }else{const hit=KEYS.filter(k=>k[0].test(low)).sort((a,b)=>(a[2]||9)-(b[2]||9))[0];r=pick(hit?hit[1]:RANDOM);}
    if(men&&FILES[men[1]]){chip=chip||men[1];r="Checked "+men[1]+" \ud83d\udc40 "+r;}
    if(mode==="Plan")r="Plan ready \ud83d\udccb 1) Create the component 2) Add the styles 3) Import it in App.tsx. Shall I execute?";
    if(mode==="Ask")r="Short answer: "+r;
    t.textContent=r;if(chip){const c=document.createElement("div");c.className="chip";c.innerHTML=fileIcon(chip)+chip;c.onclick=()=>show(chip);t.appendChild(c);}
    $("olkState").textContent=mode+" Ready";msgs.scrollTop=1e9;
  },700+Math.random()*600);
}
$("olkSend").onclick=send;
$("olkModes").addEventListener("click",e=>{const b=e.target.closest("[data-m]");if(!b)return;R.querySelectorAll("#olkModes [data-m]").forEach(x=>x.classList.remove("on"));b.classList.add("on");mode=b.dataset.m;$("olkState").textContent=mode+" Ready";});
$("olkModel").onchange=e=>add("Switched model to "+e.target.value+" \u2705","bot");
$("olkCNew").onclick=()=>{const first=msgs.querySelector(".m.me");if(first)sessions.unshift({t:first.textContent,h:msgs.innerHTML});greet();$("olkHist").style.display="none";};
$("olkCHist").onclick=()=>{const h=$("olkHist");if(h.style.display!=="none"){h.style.display="none";return;}
  h.innerHTML=sessions.length?"":'<div style="cursor:default;color:var(--mut)">No previous chats yet. Press + to start a new chat.</div>';
  sessions.forEach(s=>{const d=document.createElement("div");d.textContent=s.t;d.onclick=()=>{msgs.innerHTML=s.h;h.style.display="none";};h.appendChild(d);});h.style.display="block";};
$("olkCHelp").onclick=()=>add("Tips \ud83d\udca1 Try 'add a dashboard section', '@Pricing.tsx fix bug', or switch to Plan/Ask mode.","bot");
$("olkCExp").onclick=()=>{L.wide=!L.wide;layout();};$("olkCMin").onclick=tog("chat");

/* @ mentions */
const menEl=$("olkMen");let mi=0,ml=[];
function hideMen(){menEl.style.display="none";}
function showMen(){const m=inp.value.slice(0,inp.selectionStart).match(/@([\w.]*)$/);if(!m){hideMen();return;}
  ml=Object.keys(FILES).filter(f=>f.toLowerCase().includes(m[1].toLowerCase())).slice(0,6);if(!ml.length){hideMen();return;}mi=0;
  menEl.innerHTML=ml.map((f,i)=>'<div data-i="'+i+'" class="'+(i?"":"on")+'">'+fileIcon(f)+f+'</div>').join("");menEl.style.display="block";}
function pickMen(i){const p=inp.selectionStart,b=inp.value.slice(0,p).replace(/@[\w.]*$/,"@"+ml[i]+" ");inp.value=b+inp.value.slice(p);focusNS(inp);hideMen();}
menEl.onmousedown=e=>{const d=e.target.closest("[data-i]");if(d){e.preventDefault();pickMen(+d.dataset.i);}};
inp.addEventListener("input",showMen);
inp.addEventListener("keydown",e=>{
  if(menEl.style.display==="block"){if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();pickMen(mi);return;}
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();mi=(mi+(e.key==="ArrowDown"?1:ml.length-1))%ml.length;[...menEl.children].forEach((c,i)=>c.classList.toggle("on",i===mi));return;}if(e.key==="Escape"){hideMen();return;}}
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
const atEl=$("olkAt");
atEl.onclick=()=>{focusNS(inp);inp.value+="@";showMen();};
atEl.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();atEl.onclick();}};

layout();renderSide();renderTabs();show("Pricing.tsx");
};
})();
