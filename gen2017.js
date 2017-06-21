const fs = require('fs');
const http = require('https');
const url = require('url');
const request = require('request');
const elasticsearch = require('elasticsearch');
const xml2js = require('xml2js');
const express = require('express');
const app = express();

let db = {};

app.get('/api/db/*', function (req, res) {
  let prefix = req.path.replace(/^\/api\/db\//,"");
  let q = [];
  let keys = Object.keys(db);
  for(let i=0;i<keys.length;++i){
    if(keys[i].startsWith(prefix)){
      q.push(keys[i]);
    }
  }
  res.send(q);
});

app.get('/api/*', function (req, res) {
  let tagId = req.path.replace(/^\/api\//,"");
  let now = 1497998042934;
  let aleste = 3600*1000*24;
  if(req.query.aleste){
    aleste = 3600*1000*24*Number.parseInt(req.query.aleste.replace(/d/,""));
  }
  let since = new Date(now-aleste);
  getSummaryByDate(tagId,since,function(sum){
    res.send(sum);
  });
});

app.get('/', function (req, res) {
  res.render('browse', {tags: sortTags()});
});

app.get('/*', function (req, res) {
  let tagId = req.path.replace(/\//,"");
  let now = 1497998042934;
  if(req.query.aleste){
    let aleste = 3600*1000*24*Number.parseInt(req.query.aleste.replace(/d/,""));
    let since = new Date(now-aleste);
    getSummaryByDate(tagId,since,function(sum){
      res.render('index', {"tag": db[tagId], "sum": sum});
    });
  } else {
    res.render('ask', db[tagId]);
  }
});



function storeContent(obj){
  if(obj){
    let id = obj.id ? obj.id : obj.uuid;
    if(id){
      db["content/"+id]=obj;
    }
  }
}

function purgeTags(){
  Object.keys(db).forEach(function(k, v){
    if(k.startsWith("tag/")){
      delete db[k];
    }
  });
}

function purgeSums(){
  let keys = Object.keys(db);
  for(let i=0;i<keys.length;++i){
    let k = keys[i];
    if(k.startsWith("sum/")){
      delete db[k];
    }
  }
  persistDb();
}

function enrichContent(q){
  let content = q.pop();
  if(content){
    if(content.enriched){
      return enrichContent(q);
    }
    const url = "http://iapi.impresa.pt/pcontent/rest/v2/content/expresso/"+content.friendlyURI;
    console.log(url);
    let opt = {
      uri:url,
      timeout:3000
    };
    request.get(opt,function(err,httpResponse,body) {
      try{
        if(err || httpResponse.statusCode>299){
          console.log((httpResponse?httpResponse.statusCode:"unknown") + ": " + err);
        } else {
          delete content.code;
          delete content.headlineTitle;
          delete content.link;
          delete content.authors;
          delete content.articleType;
          delete content.domainCode;
          delete content.sponsored;
          delete content.mainCategory;
          delete content.related;
          content.enriched=true;
          let got = JSON.parse(body);
          content.tags=got.tags;
          if(got.contents){
            for(let i=0;i<got.contents.length;++i){
              let chunk = got.contents[i];
              if(chunk.html){
                content.body+="\n"+chunk.html;
              }
            }
          }
          persistDb();
        }
      } finally{
        enrichContent(q);
      }
    });
  }
}

function storeSum(sum) {
  if(sum){
      db[sum.id]=sum;
    }
    persistDb();
}

function summarize(q,sumId,after) {
  console.log("Summarizing " + sumId);
    if(db[sumId]){
      after(db[sumId]);
    } else {
    let totalText = "";
    for(let i=0;i<q.length;++i){
      let article = db[q[i].id];
      if(article && article.body) {
        totalText += "\n" + article.body;
      }
    }
    if(totalText==""){
      return;
    }
    request.post(
      {url:"https://www.tools4noobs.com",
       form: {
        action:'ajax_summarize',
        treshold_lines: 5,
        threshold: 50,
        min_sentence_length: 50,
        min_word_length: 4,
        text: totalText}
        },
    function(err,httpResponse,body){
      if(err || httpResponse.statusCode>299){
        console.log((httpResponse?httpResponse.statusCode:"unknown") + ": " + err);
        after(undefined);
      } else {
        xml2js.parseString(body, function(err, result){
          let ees = [];
          if(err){
            console.log(err);
            after(undefined);
          } else {
            let sumText = "";
            let ols = result.fieldset.ol;
            for(let m=0;m<ols.length;++m){
              let lis = ols[m].li;
              for(let n=0;n<lis.length;++n){
                ees.push({url:'null',text:lis[n]});
              }
            }

            let sum = {
              id: sumId,
              entries: ees
            }
            storeSum(sum);
            after(sum);
          }
        });
      }
    });
  }
}

function getSummaryByDate(topic,fromDate,after){
  let q = [];
  let tag = db[topic];
  let fromId;
  let toId;
  if(!tag){
    console.log("No such topic: " + topic);
    after(undefined);
    return;
  }
  for(let i=0;i<tag.articles.length;++i){
    let article = tag.articles[i];
    if(article.stamp>fromDate){
      if(!fromId){
        fromId = article.id;
      }
      q.push(article);
      toId = article.id;
    }
  }
  if(fromId) {
    summarize(q,"sum/"+fromId+"/"+toId,after);
  } else {
    after(undefined);
  }
}

function sortTags() {
  let tags = [];
  Object.keys(db).forEach(function(k, v){
    if(k.startsWith("tag/")){
      let got = db[k];
      tags.push(got);
    }
  });
  tags = tags.sort(function(a,b){
    return b.articleCount - a.articleCount;
  });
  return tags;
}

function sortArticlesInTags() {
  let tags = [];

  Object.keys(db).forEach(function(k, v){
    if(k.startsWith("tag/")){
      let got = db[k];
      tags.push(got);
    }
  });
  tags = tags.sort(function(a,b){
    return b.articleCount - a.articleCount;
  });

  for(let i=0;i<tags.length;++i){
    tags[i].articles.sort(function(a,b){
      return b.stamp - b.stamp;
    });
    /*if(tags[i].articleCount>3){
      console.log(tags[i].code+":"+tags[i].label+":"+tags[i].articleCount);
    }*/
  }
}

function processTags() {
  purgeTags();
  Object.keys(db).forEach(function(k, v){
    if(k.startsWith("content/")){
      let got = db[k];
      if(got.tags){
        for(let i=0;i<got.tags.length;++i){
          let gotTag = got.tags[i];
          let existingTag = db["tag/"+gotTag.code];
          if(!existingTag){
            existingTag=gotTag;
            db["tag/"+gotTag.code]=gotTag;
            db["tag/"+gotTag.code].articleCount=0;
            db["tag/"+gotTag.code].articles=[];
          }
          existingTag.articleCount++;
          existingTag.articles.push({id:k,stamp:Date.parse(got.publishedDate)});
        }
      }
    }
  });
  sortArticlesInTags();
  persistDb();
}

function enrich() {
  let queue = [];
  Object.keys(db).forEach(function(k, v){
    if(k.startsWith("content/")){
      queue.push(db[k]);
    }
  });
  enrichContent(queue);
  //persistDb();
}

function loadFromWeb(path,depth){
  if(depth>0){
    const url = "http://iapi.impresa.pt/pcontent/rest/v2/feed/expresso/"+path;
    console.log(url);
    request.get(url,function(err,httpResponse,body) {
      let got = JSON.parse(body);
      let until;
      Object.keys(got).forEach(function(k, v){
          storeContent(got[k]);
          until=got[k].publishedDate;
      });
      loadFromWeb("?until="+until,depth-1)
    });
  } else {
    persistDb();
  }
}

function loadDb() {
  db = JSON.parse(fs.readFileSync('db.json', 'utf8'));
  console.log("Loaded " + Object.keys(db).length + " entries")
}

function persistDb(){
  fs.writeFileSync("db.json", JSON.stringify(db), 'utf8', function(err) {
    if(err) {
        return console.log(err);
    }
    console.log("The file was saved!");
});

}

//loadFromWeb("",1000);
//purgeSums();
//loadDb();
//processTags();
//getSummaryByDate("tag/entity/people/Donald-Trump",new Date(1497691681170),function(sum){
//  console.log(sum.entries[0].text);
//});
//enrich();


app.listen(3000, function () {
  loadDb();
  app.set('views', './views');
  app.set('view engine', 'pug');
});


//go();
