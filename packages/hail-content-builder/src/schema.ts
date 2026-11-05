/** Sanity schema configuration. hailImage deliberately uses a local bundle ID,
 * not a Sanity CDN image reference. The paired asset bundle is required. */
export const contentSchema = {
  name:'hailContent',title:'Hail content',type:'array',of:[{
    type:'block',fields:[{name:'alignment',title:'Text alignment',type:'string',options:{list:['left','center','right']}}],styles:['normal','h1','h2','h3','blockquote','caption','cta'].map(value=>({title:value,value})),
    lists:[{title:'Bullets',value:'bullet'},{title:'Numbered',value:'number'}],
    marks:{decorators:['strong','em','code'].map(value=>({title:value,value})),annotations:[{
      name:'link',title:'HTTPS link',type:'object',fields:[{name:'href',type:'url'},{name:'title',type:'string'}],
    }]},
  },{
    name:'hailImage',title:'Bundled image',type:'object',fields:[
      {name:'asset',title:'Local bundle asset ID',type:'string'},
      {name:'alt',title:'Image description',type:'string'},
      {name:'caption',type:'string'},
    ],
  }],
};
