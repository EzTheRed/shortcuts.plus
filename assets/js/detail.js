(()=>{"use strict";
const A=window.ShortcutsApp;if(!A)return;
const $=A.$,esc=A.escape;
function render(item){
const cats=item.category.map(esc).join(" · ");
const link=item.link?esc(item.link):"";
const action=item.link?'<a class="button button-blue" href="'+link+'" target="_blank" rel="noopener noreferrer">'+(item.linkType==="source"?"Open source listing":"Get Shortcut")+' ↗</a><button class="button" type="button" data-copy="'+link+'">Copy link</button>':"";
document.title=item.title+" — Shortcuts+";
const meta=document.querySelector('meta[name="description"]');if(meta)meta.content=item.desc||"View this shortcut in the Shortcuts+ library.";
$("#app").innerHTML='<article class="card detail-card"><div class="card-top"><div class="icon-bubble">'+A.iconFor(item)+'</div></div><p class="eyebrow">'+cats+'</p><h1>'+esc(item.title)+'</h1>'+(item.badge?'<p class="badge">'+esc(item.badge)+'</p>':"")+'<p>'+esc(item.desc||"No description available.")+'</p><div class="hero-actions">'+action+'</div>'+(item.source&&item.source!=="UNKNOWN"?'<p class="detail-source">Source: <a href="'+esc(item.source)+'" target="_blank" rel="noopener noreferrer">'+esc(item.source)+'</a></p>':"")+(item.dateAdded?'<p class="detail-date">Added '+esc(A.formatDate(item.dateAdded))+'</p>':"")+'</article>';
}
async function start(){A.initTheme();const app=$("#app");try{const raw=new URLSearchParams(location.search).get("s");if(raw===null||raw.trim()===""||!/^[0-9]+$/.test(raw))throw new Error("This shortcut link is missing a valid entry number.");const index=Number(raw);const items=await A.getItems();const item=items.find(x=>x.jsonIndex===index);if(!item)throw new Error("That shortcut could not be found. It may have been removed from the library.");render(item);}catch(e){console.error(e);app.innerHTML='<div class="empty"><strong>Could not open shortcut.</strong><span>'+esc(e.message)+'</span><p><a href="/library.html">Browse the full library</a></p></div>';}document.addEventListener("click",e=>{const b=e.target.closest("[data-copy]");if(b)A.copy(b.dataset.copy);});}
start();})();