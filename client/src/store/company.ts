import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';

export type WorkerState = 'working'|'walking'|'meeting'|'reviewing'|'responding'|'reporting';
export type Department = { id:string; name:string; floor:number; count:number; color:string; short:string; focus:string };
export type Worker = { id:string; name:string; role:string; department:string; floor:number; manager:string; state:WorkerState; task:string; progress:number; morale:number; workload:number; autonomy:'bounded'|'supervised'|'planned'; type:'simulated'|'ai_agent'|'human' };
export type WorkOrder = { id:string; title:string; department:string; priority:'critical'|'high'|'normal'; status:'queued'|'assigned'|'in_progress'|'review'|'done'|'blocked'; progress:number; owner:string; createdAt:string; updatedAt?:string; source:'simulation'|'president'|'website'; result?:string; error?:string; plan?:Array<{title:string;department:string;rationale?:string}>; deliverables?:Array<{title:string;department:string;agent:string;status:string;output?:string;error?:string}> };
export type BrainStatus = {provider:string;model:string;configured:boolean;state:string;queueDepth:number;activeTasks:number;completedTasks:number;failedTasks:number;maxParallelTasks:number;maxSubtasks:number;lastError:string|null;workers:number;workerReality:string};
export type WebsiteHealth = {status:'healthy'|'degraded'|'down'|'unknown';code:number|null;latency:number|null;checkedAt:string|null;error:string|null};

const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const SOCKET_URL = API_URL || window.location.origin;

const definitions:Omit<Department,'count'>[] = [
{id:'exec',name:'Executive Office',floor:12,short:'EXE',color:'#d9b56d',focus:'Strategy & governance'},
{id:'engineering',name:'Engineering & Technology',floor:10,short:'ENG',color:'#58d7d0',focus:'Build, review and maintain products'},
{id:'product',name:'Product & Design',floor:9,short:'PRD',color:'#a5a0ff',focus:'Research, product strategy and design'},
{id:'sales',name:'Sales & Partnerships',floor:8,short:'SAL',color:'#e5a76f',focus:'Pipeline and customer growth'},
{id:'marketing',name:'Marketing & Communications',floor:7,short:'MKT',color:'#e68bb3',focus:'Brand, content and campaigns'},
{id:'support',name:'Customer Success & Support',floor:6,short:'CSS',color:'#7bc9f4',focus:'Support and customer outcomes'},
{id:'people',name:'People & Human Resources',floor:5,short:'PPL',color:'#b9d987',focus:'Hiring, learning and people operations'},
{id:'finance',name:'Finance & Procurement',floor:4,short:'FIN',color:'#d8c17b',focus:'Planning, accounts and procurement'},
{id:'legal',name:'Legal, Risk & Compliance',floor:3,short:'LRC',color:'#b5bec8',focus:'Policy, privacy and risk'},
{id:'operations',name:'Operations & Facilities',floor:2,short:'OPS',color:'#82c7b5',focus:'IT, facilities, logistics and safety'},
{id:'data',name:'Data & Analytics',floor:11,short:'DAT',color:'#80a9ff',focus:'Insights, BI and data science'},
{id:'webops',name:'Site Reliability & Web Ops',floor:10,short:'SRE',color:'#ff827a',focus:'Website health, observability and incidents'},
{id:'innovation',name:'Research & Innovation Lab',floor:11,short:'RDI',color:'#d29aff',focus:'Experiments and new capabilities'}
];

const roleTemplates:Record<string,string[]> = {
exec:['Chief of Staff','Chief Executive Officer','Chief Technology Officer','Chief Operating Officer','Chief Financial Officer','Chief Marketing Officer','Chief People Officer','Chief Product Officer','Chief Information Security Officer','Platform Vice President','Division Vice President','Executive Assistant'],
engineering:['Frontend Engineer','Backend Engineer','Full-Stack Engineer','Mobile Engineer','DevOps Engineer','Software Architect','QA Engineer','Data Engineer','Machine Learning Engineer','Technical Lead','Accessibility Engineer','Release Engineer'],
product:['Product Manager','UX Designer','UI Designer','User Researcher','Product Analyst','Design Operations Specialist'],
sales:['Account Executive','Sales Development Representative','Account Manager','Sales Operations Analyst','Partnerships Manager'],
marketing:['Content Strategist','Growth Marketer','Brand Designer','SEO Specialist','Campaign Manager','Communications Officer'],
support:['Customer Success Manager','Support Specialist','Onboarding Specialist','Knowledge Base Editor','Escalation Analyst'],
people:['Recruiter','HR Business Partner','Learning Specialist','People Operations Coordinator','Payroll Specialist'],
finance:['Accountant','Financial Analyst','Procurement Officer','Accounts Payable Specialist','Budget Analyst'],
legal:['Compliance Analyst','Privacy Specialist','Contract Administrator','Risk Analyst','Legal Operations Specialist'],
operations:['IT Support Technician','Facilities Coordinator','Receptionist','Office Manager','Administrative Assistant','Cleaner','Maintenance Technician','Physical Security Officer','Driver','Mailroom Clerk','Storekeeper','Catering Assistant','Meeting Coordinator','Logistics Coordinator'],
data:['Data Analyst','Business Intelligence Engineer','Data Scientist','Analytics Engineer','Reporting Specialist'],
webops:['Site Reliability Engineer','Platform Engineer','Security Analyst','Observability Engineer','Incident Commander','Web Operations Specialist'],
innovation:['Research Scientist','Prototype Engineer','Innovation Analyst','Technical Researcher']
};

const names = ['Amara','Tariro','Kuda','Nyasha','Rudo','Tawanda','Munashe','Chipo','Farai','Tendai','Simba','Rutendo','Anesu','Tapiwa','Chenai','Kundai','Makanaka','Tatenda','Shamiso','Tinashe','Lerato','Zola','Ayo','Imani','Nia','Jabari','Kai','Mila','Noah','Zuri'];
const surnames = ['Moyo','Dube','Ndlovu','Chirwa','Sithole','Mhlanga','Ncube','Mugabe','Chikore','Maseko','Banda','Nyoni','Phiri','Dlamini','Mabaso','Khumalo','Muchengeti','Mupfumi','Chari','Mutasa'];

const tasksByDept:Record<string,string[]> = {
engineering:['Review open pull requests','Improve application accessibility','Investigate a reported defect','Add regression coverage','Review dependency updates','Document a module boundary','Profile a slow route'],
product:['Review product feedback','Map a customer journey','Refine the next sprint backlog','Audit an interface flow'],
sales:['Qualify a sample prospect','Update pipeline notes','Prepare a customer brief'],
marketing:['Review content calendar','Audit campaign links','Draft a product update'],
support:['Triage incoming support cases','Refresh a help article','Review unresolved tickets'],
people:['Review onboarding checklist','Audit role descriptions','Prepare learning materials'],
finance:['Reconcile sample ledger entries','Review expense categories','Prepare a forecast draft'],
legal:['Review policy checklist','Audit data-retention documentation','Update risk register'],
operations:['Check office systems inventory','Review facilities checklist','Audit access procedures'],
data:['Validate dashboard metrics','Check data quality rules','Prepare a KPI summary'],
webops:['Run a website health check','Review latency history','Inspect incident playbook'],
innovation:['Evaluate a technical prototype','Summarize a research finding','Run an experiment review'],
exec:['Review company pulse report','Summarize department risks','Prepare leadership briefing']
};

function makeWorkOrder(i:number,department:string,source:WorkOrder['source']='simulation'):WorkOrder {
 const dept = departments.find(d=>d.id===department)!;
 const arr = tasksByDept[department]||['Review departmental priorities'];
 return {
  id:`WO-${String(i).padStart(5,'0')}`,
  title:arr[i%arr.length],
  department,
  priority:(i%47===0?'critical':i%11===0?'high':'normal') as WorkOrder['priority'],
  status:i%6===0?'review':i%5===0?'assigned':'in_progress',
  progress:15+(i*17)%80,
  owner:`${dept.short}-${String((i%Math.max(1,dept.count))+1).padStart(3,'0')}`,
  createdAt:new Date(Date.now()-((i%60)*60000)).toISOString(),
  source
 };
}

const exactCounts:Record<string,number> = {exec:12,engineering:220,product:90,sales:130,marketing:90,support:110,people:60,finance:70,legal:40,operations:58,data:60,webops:40,innovation:20};
export const departments:Department[] = definitions.map(d=>({...d,count:exactCounts[d.id]||0}));

export const seededWorkers:Worker[] = (()=>{
 const list:Worker[]=[];
 let n=0;
 for(const d of departments){
  for(let i=1;i<=d.count;i++){
   n++;
   const roles=roleTemplates[d.id]||['Specialist'];
   const role=d.id==='exec'&&i===1?'Chief of Staff':d.id==='exec'&&i===2?'Chief Executive Officer':roles[(i-1)%roles.length];
   list.push({
    id:`${d.short}-${String(i).padStart(3,'0')}`,
    name:`${names[(n*7)%names.length]} ${surnames[(n*11)%surnames.length]}`,
    role,department:d.id,floor:d.floor,
    manager:i===1?'President':`${d.short}-001`,
    state:(['working','walking','meeting','reviewing','responding','reporting'] as WorkerState[])[n%6],
    task:(tasksByDept[d.id]||['Review team priorities'])[n%((tasksByDept[d.id]||['Review team priorities']).length)],
    progress:10+(n*13)%88,morale:68+(n*7)%32,workload:45+(n*19)%52,
    autonomy:d.id==='exec'?'supervised':'bounded',type:'simulated'
   });
  }
 }
 return list;
})();

export const initialOrders:WorkOrder[]=Array.from({length:86},(_,i)=>makeWorkOrder(i+1,departments[(i*7)%departments.length].id));

type AlertLevel='info'|'warning'|'critical';
type CompanyStore={
 departments:Department[];
 workers:Worker[];
 orders:WorkOrder[];
 brain:BrainStatus|null;
 selectedDepartment:string|null;
 selectedWorker:string|null;
 activeTab:string;
 website:WebsiteHealth;
 alerts:{id:string;level:AlertLevel;title:string;detail:string;time:string}[];
 commandLog:{id:string;text:string;time:string;status:string}[];
 nightMode:boolean;
 setTab:(tab:string)=>void;
 selectDepartment:(id:string|null)=>void;
 selectWorker:(id:string|null)=>void;
 toggleMode:()=>void;
 issueCommand:(text:string,department:string,priority?:'critical'|'high'|'normal')=>Promise<boolean>;
 syncBackend:()=>Promise<void>;
 setBrain:(brain:BrainStatus)=>void;
 tick:()=>void;
 setWebsite:(health:WebsiteHealth)=>void;
 addAlert:(level:AlertLevel,title:string,detail:string)=>void;
 connectSocket:()=>void;
};

let socket:Socket|undefined;

export const useCompany=create<CompanyStore>((set,get)=>({
 departments,workers:seededWorkers,orders:initialOrders,brain:null,
 selectedDepartment:null,selectedWorker:null,activeTab:'tower',
 website:{status:'unknown',code:null,latency:null,checkedAt:null,error:null},
 alerts:[{id:'a1',level:'info',title:'Nexus simulation initialized',detail:'1,000 workforce profiles seeded. Agent execution is not configured by default.',time:new Date().toISOString()}],
 commandLog:[],nightMode:true,

 setTab:(activeTab)=>set({activeTab}),
 selectDepartment:(selectedDepartment)=>set({selectedDepartment,selectedWorker:null}),
 selectWorker:(selectedWorker)=>set({selectedWorker}),
 toggleMode:()=>set(s=>({nightMode:!s.nightMode})),

 issueCommand:async(text,department,priority='high')=>{
  const dept=get().departments.find(d=>d.id===department)||get().departments[1];
  const tempId=`LOCAL-${Date.now()}`;
  const optimistic:WorkOrder={id:tempId,title:text,department:dept.id,priority,status:'queued',progress:0,owner:'Connecting to Nexus Brain…',createdAt:new Date().toISOString(),source:'president'};
  set(s=>({
   orders:[optimistic,...s.orders],
   commandLog:[{id:tempId,text:`${dept.name}: ${text}`,time:new Date().toISOString(),status:'SUBMITTING'},...s.commandLog]
  }));

  try{
   const response=await fetch(`${API_URL}/api/agent/command`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({title:text,department:dept.id,priority,source:'president'})
   });
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw new Error(data.error||data.message||`Nexus API returned HTTP ${response.status}`);
   const order:WorkOrder={...data,source:data.source||'president'};
   set(s=>({
    orders:[order,...s.orders.filter(o=>o.id!==tempId&&o.id!==order.id)],
    commandLog:[{id:order.id,text:`${dept.name}: ${text}`,time:new Date().toISOString(),status:'ACCEPTED'},...s.commandLog.filter(x=>x.id!==tempId)],
    alerts:[{id:`al-${Date.now()}`,level:'info',title:'Directive accepted by Nexus Brain',detail:`${dept.name} task ${order.id} entered the queue. Results require human review.`,time:new Date().toISOString()},...s.alerts].slice(0,8),
    brain:data.brain||s.brain
   }));
   return true;
  }catch(error){
   const message=error instanceof Error?error.message:'Could not connect to the Nexus Brain API.';
   set(s=>({
    orders:s.orders.map(o=>o.id===tempId?{...o,status:'blocked',owner:'Nexus Brain · connection failed',error:message}:o),
    commandLog:s.commandLog.map(x=>x.id===tempId?{...x,status:'FAILED'}:x),
    alerts:[{id:`al-${Date.now()}`,level:'critical',title:'Directive could not be submitted',detail:message,time:new Date().toISOString()},...s.alerts].slice(0,8)
   }));
   return false;
  }
 },

 setBrain:(brain)=>set({brain}),

 syncBackend:async()=>{
  try{
   const [brainRes,ordersRes]=await Promise.all([
    fetch(`${API_URL}/api/brain/status`),
    fetch(`${API_URL}/api/work-orders`)
   ]);
   if(brainRes.ok){
    const brain:BrainStatus=await brainRes.json();
    set({brain});
   }
   if(ordersRes.ok){
    const incoming:WorkOrder[]=await ordersRes.json();
    set(s=>{
     const byId=new Map(s.orders.map(o=>[o.id,o]));
     for(const o of incoming)byId.set(o.id,{...o,source:o.source||'president'});
     return {orders:[...byId.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
    });
   }
  }catch{
   // Backend may be unavailable; a later sync can retry.
  }
 },

 tick:()=>set(s=>({
  workers:s.workers.map((w,i)=>{
   if(i%4!==0)return w;
   const advance=1+(i%4);
   return {...w,progress:(w.progress+advance)%101,state:w.progress>94?'reviewing':w.state};
  }),
  orders:s.orders.map((o,i)=>o.source!=='simulation'||o.status==='done'||o.status==='blocked'
   ?o
   :{...o,progress:Math.min(98,o.progress+(i%9===0?0:1)),status:o.progress>88?'review':o.status==='queued'?'assigned':'in_progress'})
 })),

 setWebsite:(website)=>set(s=>({
  website,
  alerts:website.status==='down'
   ?[{id:`web-${Date.now()}`,level:'critical',title:'Production website unreachable',detail:website.error||'Health endpoint did not respond.',time:new Date().toISOString()},...s.alerts].slice(0,8)
   :s.alerts
 })),

 addAlert:(level,title,detail)=>set(s=>({
  alerts:[{id:`a-${Date.now()}`,level,title,detail,time:new Date().toISOString()},...s.alerts].slice(0,8)
 })),

 connectSocket:()=>{
  if(socket)return;
  socket=io(SOCKET_URL,{autoConnect:true,timeout:5000,reconnectionAttempts:5,transports:['websocket','polling']});
  socket.on('connect_error',error=>get().addAlert('warning','Live connection unavailable',error.message));
  socket.on('website:health',(h:WebsiteHealth)=>get().setWebsite(h));
  socket.on('tower:alert',(a:{level:AlertLevel;title:string;detail:string})=>get().addAlert(a.level,a.title,a.detail));
  socket.on('brain:status',(b:BrainStatus)=>get().setBrain(b));
  socket.on('work-order:created',(o:WorkOrder)=>set(s=>({orders:[o,...s.orders.filter(x=>x.id!==o.id)]})));
  socket.on('work-order:update',(o:WorkOrder)=>set(s=>({orders:[o,...s.orders.filter(x=>x.id!==o.id)]})));
  void get().syncBackend();
 }
}));
